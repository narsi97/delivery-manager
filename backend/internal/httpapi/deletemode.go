package httpapi

import (
	"log"
	"net/http"
	"time"

	"delivery-manager/internal/domain"
)

// Turning the delete buttons on, for a while.
//
// Deleting a customer takes their delivery history with them and there
// is no undo. That is not something to leave switched on, and it is not
// something to guard with a confirm dialog either — a dialog you see
// every day is a dialog you stop reading. So the buttons are simply not
// there until somebody says they are tidying up, and they take
// themselves away again.
//
// Enforced here rather than only hidden in the app. A safety catch you
// can get past by opening the developer tools is not a safety catch, and
// the timer would be decoration.

// How long the window can be. An hour is the default because tidying up
// takes minutes; a day exists for the one afternoon somebody is
// reorganising the whole round.
var deleteModeHours = map[int]bool{1: true, 4: true, 24: true}

func (s *Server) handleSetDeleteMode(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Hours int `json:"hours"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	var until *time.Time
	if req.Hours != 0 {
		if !deleteModeHours[req.Hours] {
			writeError(w, http.StatusBadRequest, "delete mode lasts 1, 4 or 24 hours", "invalid_window")
			return
		}
		at := time.Now().UTC().Add(time.Duration(req.Hours) * time.Hour)
		until = &at
	}

	updated, err := s.store.SetUserDeleteMode(r.Context(), sess.Business.ID, sess.User.ID, until)
	if err != nil {
		writeStoreError(w, err, "account")
		return
	}
	if until == nil {
		log.Printf("%s turned delete mode off", updated.Name)
	} else {
		log.Printf("%s turned delete mode on until %s", updated.Name, until.Format(time.RFC3339))
	}
	writeJSON(w, http.StatusOK, updated)
}

// requireDeleteMode is the gate every delete goes through. It reads the
// stored user rather than the session copy, so closing the window takes
// effect on the next request instead of at the next sign-in.
func (s *Server) requireDeleteMode(w http.ResponseWriter, r *http.Request, sess session) bool {
	user, err := s.store.GetUserByID(r.Context(), sess.Business.ID, sess.User.ID)
	if err != nil {
		writeStoreError(w, err, "account")
		return false
	}
	if !user.CanDelete(time.Now().UTC()) {
		writeError(w, http.StatusForbidden,
			"deleting is switched off. Turn it on from Manage account, and it switches itself back off after.",
			"delete_mode_off")
		return false
	}
	return true
}

// What a delete would take with it, counted before it happens so the
// screen can say so rather than asking somebody to guess.
func (s *Server) handleCustomerDeletePreview(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	customer, err := s.store.GetCustomer(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "customer")
		return
	}

	standing, deliveries, delivered, err := s.customerFootprint(r, sess, customer.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "store_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":              customer.Name,
		"standing_orders":   standing,
		"deliveries":        deliveries,
		"delivered":         delivered,
		"delete_mode_until": userDeleteWindow(r, s, sess),
	})
}

func userDeleteWindow(r *http.Request, s *Server, sess session) *time.Time {
	user, err := s.store.GetUserByID(r.Context(), sess.Business.ID, sess.User.ID)
	if err != nil {
		return nil
	}
	return user.DeleteModeUntil
}

// How much of the record is about this customer alone: how many standing
// orders, how many deliveries in total, and how many of those actually
// happened. The last number is the one that matters — a customer
// imported this morning has none, and one who has been served for a year
// is a business record somebody may need in an argument about a bill.
func (s *Server) customerFootprint(r *http.Request, sess session, customerID string) (int, int, int, error) {
	subs, err := s.store.ListRecurringOrders(r.Context(), sess.Business.ID)
	if err != nil {
		return 0, 0, 0, err
	}
	standing := 0
	for _, sub := range subs {
		if sub.CustomerID == customerID {
			standing++
		}
	}

	// Ninety days back and thirty forward is the same span the customer
	// timeline reads, and covers everything the app itself would show.
	today, err := time.Parse(domain.DateLayout, sess.Business.Today())
	if err != nil {
		return 0, 0, 0, err
	}
	from := today.AddDate(0, 0, -maxHistoryDays).Format(domain.DateLayout)
	to := today.AddDate(0, 0, maxUpcomingDays).Format(domain.DateLayout)
	orders, err := s.store.ListCustomerDailyOrders(r.Context(), sess.Business.ID, customerID, from, to)
	if err != nil {
		return 0, 0, 0, err
	}
	delivered := 0
	for _, o := range orders {
		if o.Status == domain.StatusDelivered {
			delivered++
		}
	}
	return standing, len(orders), delivered, nil
}

func (s *Server) handleDeleteCustomer(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	if !s.requireDeleteMode(w, r, sess) {
		return
	}

	customer, err := s.store.GetCustomer(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "customer")
		return
	}
	standing, deliveries, delivered, err := s.customerFootprint(r, sess, customer.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "store_error")
		return
	}
	if err := s.store.DeleteCustomer(r.Context(), sess.Business.ID, customer.ID); err != nil {
		writeStoreError(w, err, "customer")
		return
	}

	log.Printf("%s deleted customer %s (%d standing orders, %d deliveries, %d of them delivered)",
		sess.User.Name, customer.Name, standing, deliveries, delivered)
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted":         customer.Name,
		"standing_orders": standing,
		"deliveries":      deliveries,
	})
}

func (s *Server) handleDeleteDriver(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	if !s.requireDeleteMode(w, r, sess) {
		return
	}

	id := r.PathValue("id")
	// Two refusals that have to exist. Either one locks a business out of
	// its own account, and there is no signup to recover through — the
	// only way back would be somebody with database access.
	if id == sess.User.ID {
		writeError(w, http.StatusBadRequest, "you cannot delete your own account", "not_yourself")
		return
	}
	target, err := s.store.GetUserByID(r.Context(), sess.Business.ID, id)
	if err != nil {
		writeStoreError(w, err, "driver")
		return
	}
	if target.Role.CanAdmin() {
		users, err := s.store.ListUsers(r.Context(), sess.Business.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error(), "store_error")
			return
		}
		admins := 0
		for _, u := range users {
			if u.Role.CanAdmin() && u.Active {
				admins++
			}
		}
		if admins <= 1 {
			writeError(w, http.StatusBadRequest,
				"that is the only admin left — make somebody else an admin first", "last_admin")
			return
		}
	}

	if err := s.store.DeleteUser(r.Context(), sess.Business.ID, id); err != nil {
		writeStoreError(w, err, "driver")
		return
	}
	log.Printf("%s deleted %s", sess.User.Name, target.Name)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": target.Name})
}

func (s *Server) handleDeleteServiceArea(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	if !s.requireDeleteMode(w, r, sess) {
		return
	}

	area, err := s.store.GetServiceArea(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "service route")
		return
	}
	customers, err := s.store.ListCustomers(r.Context(), sess.Business.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "store_error")
		return
	}
	freed := 0
	for _, c := range customers {
		if c.ServiceAreaID != nil && *c.ServiceAreaID == area.ID {
			freed++
		}
	}

	if err := s.store.DeleteServiceArea(r.Context(), sess.Business.ID, area.ID); err != nil {
		writeStoreError(w, err, "service route")
		return
	}
	log.Printf("%s deleted service route %s (%d customers handed back to their pins)", sess.User.Name, area.Name, freed)
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted": area.Name,
		// The ones who were on it by hand now fall back to whatever their
		// pin says, which the screen should tell somebody.
		"unassigned": freed,
	})
}
