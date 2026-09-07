package httpapi

import (
	"fmt"
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

// handleDeleteProduct removes a size nobody has ordered. A product that
// has been delivered stays: daily_orders and recurring_orders reference
// it, and a delivery record that has forgotten what it delivered is not
// a record. The two refusals are worded as facts about the data rather
// than as errors, because from the admin's side that is what they are.
func (s *Server) handleDeleteProduct(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	if !s.requireDeleteMode(w, r, sess) {
		return
	}

	product, err := s.store.GetProduct(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "product")
		return
	}

	// Checked here rather than left to the foreign key so the sentence can
	// say how many, which is what decides whether they go and edit those
	// standing orders or leave the product alone.
	subs, err := s.store.ListRecurringOrders(r.Context(), sess.Business.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "store_error")
		return
	}
	standing := 0
	for _, sub := range subs {
		if sub.ProductID == product.ID {
			standing++
		}
	}
	if standing > 0 {
		writeError(w, http.StatusConflict,
			fmt.Sprintf("%s is on %d standing order%s — change those first, or turn it off instead of deleting it",
				product.Name, standing, map[bool]string{true: "", false: "s"}[standing == 1]),
			"in_use")
		return
	}

	if err := s.store.DeleteProduct(r.Context(), sess.Business.ID, product.ID); err != nil {
		writeStoreError(w, err, "product")
		return
	}
	log.Printf("%s deleted product %s", sess.User.Name, product.Name)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": product.Name})
}

// handleReset empties whole kinds of thing at once.
//
// A business setting up for real does this two or three times — a trial
// import that came out wrong, a list loaded against the wrong route —
// and doing it one customer at a time through thirty-eight confirmations
// is not a fix, it is a punishment. What it is not is a factory reset:
// the business, its products and its admins stay, because those are the
// things somebody would have to be given back by hand.
//
// Behind the same delete window as everything else, and it says what it
// removed rather than reporting success.
func (s *Server) handleReset(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	if !s.requireDeleteMode(w, r, sess) {
		return
	}

	var req struct {
		Customers    bool `json:"customers"`
		Drivers      bool `json:"drivers"`
		ServiceAreas bool `json:"service_areas"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !req.Customers && !req.Drivers && !req.ServiceAreas {
		writeError(w, http.StatusBadRequest, "pick at least one thing to clear", "nothing_selected")
		return
	}

	removed := map[string]int{}

	// Customers first. Their orders go with them, and a service route
	// deleted underneath them would leave the rounds referring to
	// customers this is about to remove anyway.
	if req.Customers {
		customers, err := s.store.ListCustomers(r.Context(), sess.Business.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error(), "store_error")
			return
		}
		for _, c := range customers {
			if err := s.store.DeleteCustomer(r.Context(), sess.Business.ID, c.ID); err != nil {
				writeStoreError(w, err, "customer")
				return
			}
			removed["customers"]++
		}
	}

	if req.ServiceAreas {
		areas, err := s.store.ListServiceAreas(r.Context(), sess.Business.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error(), "store_error")
			return
		}
		for _, a := range areas {
			if err := s.store.DeleteServiceArea(r.Context(), sess.Business.ID, a.ID); err != nil {
				writeStoreError(w, err, "service route")
				return
			}
			removed["service_areas"]++
		}
	}

	// Drivers, but never an admin and never yourself. An account that can
	// administer the business is the way back into it — there is no
	// signup and no password reset — so a checkbox must not be able to
	// take one away. The owner of a one-person dairy is an admin_driver,
	// and "clear the drivers" from them means the people they hired.
	if req.Drivers {
		users, err := s.store.ListUsers(r.Context(), sess.Business.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error(), "store_error")
			return
		}
		for _, u := range users {
			if u.ID == sess.User.ID || u.Role.CanAdmin() || !u.Role.CanDrive() {
				continue
			}
			if err := s.store.DeleteUser(r.Context(), sess.Business.ID, u.ID); err != nil {
				writeStoreError(w, err, "driver")
				return
			}
			removed["drivers"]++
		}
	}

	log.Printf("%s cleared %d customers, %d service routes, %d drivers",
		sess.User.Name, removed["customers"], removed["service_areas"], removed["drivers"])
	writeJSON(w, http.StatusOK, map[string]any{"removed": removed})
}
