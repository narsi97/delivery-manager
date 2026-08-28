package httpapi

import (
	"log"
	"net/http"
	"strings"

	"delivery-manager/internal/domain"
	"delivery-manager/internal/route"
)

// handleMoveStop moves one delivery onto a different round (or off every
// round, by sending an empty route_id).
//
// The automatic split is good, not omniscient. It knows where the pins
// are; it doesn't know that this customer is the driver's mother-in-law,
// or that the far end of Round 3 is across a level crossing that shuts at
// seven. So an admin looking at the map has to be able to say "that one
// goes with the other round" and have it stick.
//
// Both affected rounds are re-ordered afterwards, because a stop dropped
// into the middle of someone else's round is only useful if the round
// then makes sense to drive. That is the whole difference between moving
// a stop and merely relabelling it.
func (s *Server) handleMoveStop(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		// Empty means "take it off its round" — the stop goes back to
		// being unrouted rather than moving anywhere.
		RouteID string `json:"route_id"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	order, err := s.store.GetDailyOrder(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "delivery")
		return
	}

	// A completed delivery's round is a record of where it was actually
	// made. Moving it would rewrite history, and the number it feeds
	// (which round did what) would quietly stop being true.
	if order.Status != domain.StatusPending {
		writeError(w, http.StatusBadRequest,
			"this delivery is already "+string(order.Status)+" — only pending deliveries can be moved between rounds",
			"not_pending")
		return
	}

	target := strings.TrimSpace(req.RouteID)
	var targetRoute domain.Route
	if target != "" {
		targetRoute, err = s.store.GetRoute(r.Context(), sess.Business.ID, target)
		if err != nil {
			writeStoreError(w, err, "route")
			return
		}
		if targetRoute.RouteDate != order.DeliveryDate {
			writeError(w, http.StatusBadRequest,
				"that round is for a different day", "wrong_date")
			return
		}
	}

	source := ""
	if order.RouteID != nil {
		source = *order.RouteID
	}
	if source == target {
		s.respondWithDay(w, r, order.DeliveryDate)
		return
	}

	orders, err := s.store.ListDailyOrders(r.Context(), sess.Business.ID, order.DeliveryDate)
	if err != nil {
		writeStoreError(w, err, "deliveries")
		return
	}
	customers, err := s.store.ListCustomers(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "customers")
		return
	}
	customersByID := map[string]domain.Customer{}
	for _, c := range customers {
		customersByID[c.ID] = c
	}

	// Target first: this is what actually moves the stop. Doing it in
	// this order means the source rebuild below already sees the stop as
	// belonging elsewhere, so there is no window where it sits on both
	// rounds or neither.
	if target != "" {
		members := []string{order.ID}
		for _, o := range orders {
			if o.ID != order.ID && o.RouteID != nil && *o.RouteID == target {
				members = append(members, o.ID)
			}
		}
		if err := s.reorderRoute(r, sess.Business.ID, targetRoute, members, orders, customersByID); err != nil {
			writeStoreError(w, err, "route")
			return
		}
	} else {
		// Off every round: detach it and leave it for the admin to place.
		order.RouteID = nil
		order.Sequence = 0
		if _, err := s.store.UpdateDailyOrder(r.Context(), order); err != nil {
			writeStoreError(w, err, "delivery")
			return
		}
	}

	if source != "" {
		sourceRoute, err := s.store.GetRoute(r.Context(), sess.Business.ID, source)
		if err == nil {
			members := []string{}
			for _, o := range orders {
				if o.ID != order.ID && o.RouteID != nil && *o.RouteID == source {
					members = append(members, o.ID)
				}
			}
			if err := s.reorderRoute(r, sess.Business.ID, sourceRoute, members, orders, customersByID); err != nil {
				writeStoreError(w, err, "route")
				return
			}
		}
	}

	log.Printf("moved delivery %s from route %q to %q", order.ID, source, target)
	s.respondWithDay(w, r, order.DeliveryDate)
}

// reorderRoute re-optimizes one round from its own stored start point and
// writes the new sequence. An unpinned member keeps its place on the
// round but can't take part in the ordering, so it is appended after the
// pinned ones rather than dropped.
func (s *Server) reorderRoute(
	r *http.Request,
	businessID string,
	rt domain.Route,
	memberIDs []string,
	orders []domain.DailyOrder,
	customersByID map[string]domain.Customer,
) error {
	byID := map[string]domain.DailyOrder{}
	for _, o := range orders {
		byID[o.ID] = o
	}

	points := make([]route.Point, 0, len(memberIDs))
	unpinned := make([]string, 0)
	for _, id := range memberIDs {
		o, ok := byID[id]
		if !ok {
			continue
		}
		customer, known := customersByID[o.CustomerID]
		if !known || !customer.HasPin() {
			unpinned = append(unpinned, id)
			continue
		}
		points = append(points, route.Point{ID: id, Lat: customer.Lat, Lng: customer.Lng})
	}

	ordered, meters := route.Optimize(route.Point{Lat: rt.StartLat, Lng: rt.StartLng}, points)
	orderedIDs := make([]string, 0, len(ordered)+len(unpinned))
	for _, p := range ordered {
		orderedIDs = append(orderedIDs, p.ID)
	}
	orderedIDs = append(orderedIDs, unpinned...)

	if err := s.store.AssignStops(r.Context(), businessID, rt.ID, orderedIDs); err != nil {
		return err
	}
	rt.EstimatedMeters = meters
	_, err := s.store.UpdateRoute(r.Context(), rt)
	return err
}
