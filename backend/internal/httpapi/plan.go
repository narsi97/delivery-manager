package httpapi

import (
	"fmt"
	"log"
	"net/http"
	"strings"

	"delivery-manager/internal/domain"
	"delivery-manager/internal/route"
)

// maxPlannedRounds is the ceiling on "split today across N drivers". Ten
// is not a technical limit — it is the point past which a picker stops
// being a picker, and well past the number of vans any business this
// product targets runs in one morning.
const maxPlannedRounds = 10

// handlePlanRounds splits a day's deliveries across a chosen number of
// rounds and orders each one.
//
// This is the deliberate counterpart to the automatic per-service-area
// rounds (see ensureDayRounds): those answer "where do we deliver", this
// answers "how many drivers are out today". A business with two service
// areas and four drivers cannot express that with areas alone, and a
// business whose regular driver called in sick needs to re-cut the same
// work three ways instead of four — neither is a change to where the
// customers are.
//
// It replaces the day's rounds rather than adding to them. Planning is
// the admin saying what today looks like; leaving the previous plan
// half-standing next to the new one would mean neither is true.
// Deliveries are never touched — only which round they sit on.
func (s *Server) handlePlanRounds(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Count int    `json:"count"`
		Date  string `json:"date"`
		// StartLat/StartLng is where every round begins. Defaults to the
		// business's own home location, which is the depot for all but
		// the unusual business.
		StartLat *float64 `json:"start_lat"`
		StartLng *float64 `json:"start_lng"`
		// ReturnHome counts the drive back to the start as part of each
		// round, which changes the order chosen — see
		// route.OptimizeReturning.
		ReturnHome bool `json:"return_home"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	if req.Count < 1 || req.Count > maxPlannedRounds {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("count must be between 1 and %d", maxPlannedRounds), "invalid_count")
		return
	}

	date := strings.TrimSpace(req.Date)
	if date == "" {
		date = sess.Business.Today()
	}
	if !validDate(date) {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	start := route.Point{Lat: sess.Business.HomeLat, Lng: sess.Business.HomeLng}
	if req.StartLat != nil && req.StartLng != nil {
		start = route.Point{Lat: *req.StartLat, Lng: *req.StartLng}
	}
	if !validCoordinates(start.Lat, start.Lng) {
		writeError(w, http.StatusBadRequest, "start_lat/start_lng are not a valid location", "invalid_location")
		return
	}
	if start.Lat == 0 && start.Lng == 0 {
		writeError(w, http.StatusBadRequest,
			"set your home location on the Business tab first, or send a start point — rounds have to begin somewhere",
			"no_start_point")
		return
	}

	orders, err := s.store.ListDailyOrders(r.Context(), sess.Business.ID, date)
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

	// Only work that is still open and actually routable gets re-cut. A
	// delivery already completed keeps the round it was completed on —
	// re-planning the morning must not rewrite the record of a stop the
	// driver already made.
	points := make([]route.Point, 0, len(orders))
	skippedUnpinned := 0
	for _, o := range orders {
		if o.Status != domain.StatusPending {
			continue
		}
		customer, known := customersByID[o.CustomerID]
		if !known {
			continue
		}
		if !customer.HasPin() {
			skippedUnpinned++
			continue
		}
		points = append(points, route.Point{ID: o.ID, Lat: customer.Lat, Lng: customer.Lng})
	}

	if len(points) == 0 {
		writeError(w, http.StatusBadRequest,
			"there are no pending, pinned deliveries to plan for this day", "no_stops")
		return
	}

	existing, err := s.store.ListRoutes(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "routes")
		return
	}
	// Rounds with completed work on them are history, not plan. Leave
	// them exactly as they are and plan around them.
	completedOn := map[string]bool{}
	for _, o := range orders {
		if o.Status != domain.StatusPending && o.RouteID != nil {
			completedOn[*o.RouteID] = true
		}
	}

	// Names have to dodge the rounds being kept: a round holding
	// completed work stays put, and it is very likely called "Round 1"
	// already (one round per name per day is a database constraint, not a
	// preference). Numbering skips whatever is taken.
	taken := map[string]bool{}
	for _, rt := range existing {
		if completedOn[rt.ID] {
			taken[rt.Name] = true
		}
	}
	nextName := func() string {
		for n := 1; ; n++ {
			candidate := fmt.Sprintf("Round %d", n)
			if !taken[candidate] {
				taken[candidate] = true
				return candidate
			}
		}
	}

	groups := route.Partition(points, req.Count)

	// Build the new plan before removing the old one, so a failure
	// halfway leaves the day with its previous rounds rather than none.
	type planned struct {
		name       string
		start      route.Point
		orderedIDs []string
		meters     float64
	}
	plans := make([]planned, 0, len(groups))
	for _, group := range groups {
		if len(group) == 0 {
			continue
		}
		var ordered []route.Point
		var meters float64
		if req.ReturnHome {
			ordered, meters = route.OptimizeReturning(start, group, start)
		} else {
			ordered, meters = route.Optimize(start, group)
		}
		ids := make([]string, 0, len(ordered))
		for _, p := range ordered {
			ids = append(ids, p.ID)
		}
		plans = append(plans, planned{
			name:       nextName(),
			start:      start,
			orderedIDs: ids,
			meters:     meters,
		})
	}

	for _, rt := range existing {
		if completedOn[rt.ID] {
			continue
		}
		if err := s.store.DeleteRoute(r.Context(), sess.Business.ID, rt.ID); err != nil {
			writeStoreError(w, err, "route")
			return
		}
	}

	for _, p := range plans {
		created, err := s.store.CreateRoute(r.Context(), domain.Route{
			ID:              domain.NewID(),
			BusinessID:      sess.Business.ID,
			RouteDate:       date,
			Name:            p.name,
			Status:          domain.RouteDraft,
			StartLat:        p.start.Lat,
			StartLng:        p.start.Lng,
			EstimatedMeters: p.meters,
		})
		if err != nil {
			writeStoreError(w, err, "route")
			return
		}
		if err := s.store.AssignStops(r.Context(), sess.Business.ID, created.ID, p.orderedIDs); err != nil {
			writeStoreError(w, err, "route")
			return
		}
	}

	log.Printf("planned %d rounds for business %s on %s (return home: %v)",
		len(plans), sess.Business.ID, date, req.ReturnHome)

	s.respondWithDay(w, r, date)
}
