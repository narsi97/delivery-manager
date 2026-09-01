package httpapi

import (
	"log"
	"net/http"
	"sort"

	"delivery-manager/internal/domain"
)

// Moving a stop by hand.
//
// The optimizer is right most of the time and wrong in ways only the
// person who knows the round can see — a gate that is locked before
// seven, a dog, a customer who asked to be last. Priority tiers cover
// the cases a business can state as a rule (see domain.PriorityTier);
// this covers the ones it can only point at.
//
// Moving anything pins the whole route: from then on the optimizer stops
// rearranging it, and a stop added later is appended rather than slotted
// in by distance. Without that, an admin who drags a stop to the front
// loses it the moment anything else about the day changes, which reads
// as the app ignoring them. "Re-order stops" in the route's own options
// is the deliberate way back to an optimized order.
func (s *Server) handleMoveStopPosition(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		// 1-based, and clamped rather than rejected: asking to move the
		// first stop up is a normal thing for a person to do, and the
		// useful answer is "it is already first", not an error.
		Position int `json:"position"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	order, err := s.store.GetDailyOrder(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "delivery")
		return
	}
	if order.RouteID == nil {
		writeError(w, http.StatusBadRequest,
			"that delivery is not on a route yet, so there is nothing to move it within", "not_on_a_route")
		return
	}

	rt, err := s.store.GetRoute(r.Context(), sess.Business.ID, *order.RouteID)
	if err != nil {
		writeStoreError(w, err, "route")
		return
	}

	all, err := s.store.ListDailyOrders(r.Context(), sess.Business.ID, rt.RouteDate)
	if err != nil {
		writeStoreError(w, err, "deliveries")
		return
	}

	// The route's stops as they currently stand, in the order a driver
	// would work them.
	onRoute := make([]domain.DailyOrder, 0, len(all))
	for _, o := range all {
		if o.RouteID != nil && *o.RouteID == rt.ID {
			onRoute = append(onRoute, o)
		}
	}
	sort.SliceStable(onRoute, func(i, j int) bool { return onRoute[i].Sequence < onRoute[j].Sequence })

	from := -1
	for i, o := range onRoute {
		if o.ID == order.ID {
			from = i
			break
		}
	}
	if from == -1 {
		writeError(w, http.StatusConflict, "that delivery is no longer on this route", "moved_away")
		return
	}

	to := req.Position - 1
	if to < 0 {
		to = 0
	}
	if to > len(onRoute)-1 {
		to = len(onRoute) - 1
	}
	if to == from {
		s.respondWithDay(w, r, rt.RouteDate)
		return
	}

	moved := onRoute[from]
	rest := append(append([]domain.DailyOrder{}, onRoute[:from]...), onRoute[from+1:]...)
	reordered := append(append(append([]domain.DailyOrder{}, rest[:to]...), moved), rest[to:]...)

	ids := make([]string, 0, len(reordered))
	for _, o := range reordered {
		ids = append(ids, o.ID)
	}
	if err := s.store.AssignStops(r.Context(), sess.Business.ID, rt.ID, ids); err != nil {
		writeStoreError(w, err, "route")
		return
	}

	if !rt.ManualOrder {
		rt.ManualOrder = true
		if _, err := s.store.UpdateRoute(r.Context(), rt); err != nil {
			// The move itself succeeded; failing to pin only means the
			// optimizer may rearrange later, which is recoverable.
			log.Printf("pin route %s after manual move: %v", rt.ID, err)
		}
	}

	s.respondWithDay(w, r, rt.RouteDate)
}
