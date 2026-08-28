package httpapi

import (
	"log"
	"net/http"

	"delivery-manager/internal/domain"
)

// handleDeleteRoute removes one route. Its deliveries are not deleted —
// they go back to being unrouted, which is where an admin would look for
// them.
//
// A route carrying work a driver already completed is refused. That
// route is the record of where those deliveries were actually made, and
// deleting it would quietly detach them, leaving deliveries marked
// delivered by nobody in particular. Same rule the planner already
// follows when it re-cuts a day.
func (s *Server) handleDeleteRoute(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	id := r.PathValue("id")

	route, err := s.store.GetRoute(r.Context(), sess.Business.ID, id)
	if err != nil {
		writeStoreError(w, err, "route")
		return
	}

	orders, err := s.store.ListDailyOrders(r.Context(), sess.Business.ID, route.RouteDate)
	if err != nil {
		writeStoreError(w, err, "deliveries")
		return
	}
	for _, o := range orders {
		if o.RouteID != nil && *o.RouteID == id && o.Status != domain.StatusPending {
			writeError(w, http.StatusBadRequest,
				"this route has deliveries that were already completed on it — those would lose their record. Move the remaining stops instead.",
				"has_completed_work")
			return
		}
	}

	if err := s.store.DeleteRoute(r.Context(), sess.Business.ID, id); err != nil {
		writeStoreError(w, err, "route")
		return
	}

	log.Printf("deleted route %s (%s) for business %s", id, route.Name, sess.Business.ID)
	s.respondWithDay(w, r, route.RouteDate)
}

// handleResetRoutes clears a day's routes and starts over.
//
// "Start over" rather than "delete everything": with service areas set
// up, the next read prepares the per-area routes again (see
// ensureDayRounds), so this puts the day back to what the business would
// have had without anyone planning it by hand. That is what an admin who
// has made a mess of a morning actually wants.
//
// Routes holding completed work are kept, for the same reason
// handleDeleteRoute refuses them.
func (s *Server) handleResetRoutes(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	date, ok := resolveDate(sess.Business, r)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	routes, err := s.store.ListRoutes(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "routes")
		return
	}
	orders, err := s.store.ListDailyOrders(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "deliveries")
		return
	}

	protected := map[string]bool{}
	for _, o := range orders {
		if o.RouteID != nil && o.Status != domain.StatusPending {
			protected[*o.RouteID] = true
		}
	}

	removed, kept := 0, 0
	for _, route := range routes {
		if protected[route.ID] {
			kept++
			continue
		}
		if err := s.store.DeleteRoute(r.Context(), sess.Business.ID, route.ID); err != nil {
			writeStoreError(w, err, "route")
			return
		}
		removed++
	}

	log.Printf("reset %s for business %s: removed %d routes, kept %d with completed work",
		date, sess.Business.ID, removed, kept)
	s.respondWithDay(w, r, date)
}
