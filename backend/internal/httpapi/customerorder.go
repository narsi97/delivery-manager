package httpapi

import (
	"log"
	"net/http"
	"strings"
)

// The admin's own visiting order.
//
// Priority tiers answer "who comes first" in the broad sense — a shop, a
// school run, everyone else. They do not answer "and in what order,
// exactly", and on a milk round that question has a real answer: the
// same streets in the same sequence every morning, learned over years,
// which no shortest-path calculation can know.
//
// So the roster can be dragged into that order and it sticks. Ordering
// is per-list rather than global: an admin arranging Nalgonda is saying
// nothing about Kodad, and the ids they didn't send keep the rank they
// had. See domain.Customer.Rank and RouteBand for how little this
// disturbs the businesses that never touch it.
//
// maxOrderedCustomers is a sanity bound, not a product limit — it is
// larger than any roster this app is built for, and exists so a
// malformed request can't ask the database to renumber a million rows.
const maxOrderedCustomers = 5000

func (s *Server) handleSetCustomerOrder(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		// CustomerIDs in the order they should be visited. The first
		// becomes rank 1.
		CustomerIDs []string `json:"customer_ids"`
		// Clear puts the listed customers back to unranked instead,
		// handing their order back to the shortest path. Same list, one
		// flag, because "undo this" is about exactly the customers the
		// admin is looking at.
		Clear bool `json:"clear"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	ids := make([]string, 0, len(req.CustomerIDs))
	seen := map[string]bool{}
	for _, id := range req.CustomerIDs {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		writeError(w, http.StatusBadRequest, "no customers to order", "no_customers")
		return
	}
	if len(ids) > maxOrderedCustomers {
		writeError(w, http.StatusBadRequest, "too many customers in one order", "too_many_customers")
		return
	}

	// Every id has to belong to this business before anything is
	// written, so a stray id can't leave half a town renumbered.
	for _, id := range ids {
		if _, err := s.store.GetCustomer(r.Context(), sess.Business.ID, id); err != nil {
			writeStoreError(w, err, "customer")
			return
		}
	}

	var err error
	if req.Clear {
		err = s.store.ClearCustomerOrder(r.Context(), sess.Business.ID, ids)
	} else {
		err = s.store.SetCustomerOrder(r.Context(), sess.Business.ID, ids)
	}
	if err != nil {
		writeStoreError(w, err, "customers")
		return
	}

	// Today's routes were built from the old order, so rebuild them
	// rather than leaving the screen showing an order the admin has just
	// changed. Same reasoning as changing where a driver finishes.
	if err := s.reorderTodayForOrderChange(r, sess); err != nil {
		log.Printf("re-order today after a customer order change: %v", err)
	}

	customers, err := s.store.ListCustomers(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "customers")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"customers": customers})
}

// reorderTodayForOrderChange re-runs the ordering for every route today
// that isn't pinned by hand. A route somebody arranged stop-by-stop is
// left alone: they were more specific than the roster order, and the
// more specific instruction wins.
func (s *Server) reorderTodayForOrderChange(r *http.Request, sess session) error {
	date := sess.Business.Today()
	routes, err := s.store.ListRoutes(r.Context(), sess.Business.ID, date)
	if err != nil {
		return err
	}
	for _, rt := range routes {
		if rt.ManualOrder {
			continue
		}
		if err := s.reorderForEnd(r, sess.Business.ID, rt); err != nil {
			return err
		}
	}
	return nil
}
