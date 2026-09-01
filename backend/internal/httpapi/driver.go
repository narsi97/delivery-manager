package httpapi

import (
	"log"
	"net/http"
	"strings"
	"time"

	"delivery-manager/internal/domain"
)

type driverTodayResponse struct {
	Date  string        `json:"date"`
	Route *domain.Route `json:"route"`
	Stops []domain.Stop `json:"stops"`
	// Remaining is what the driver actually wants to know at a glance —
	// how many doors are left — so it's computed server-side rather than
	// left to each client to derive.
	Remaining int `json:"remaining"`
	// Captures travels with the round rather than being fetched
	// separately, keeping the "one request to start work" promise: the
	// app needs these to know what to ask for at each door, and a second
	// request is a second chance to fail on a bad connection.
	Captures []domain.CaptureSpec `json:"captures"`
	// Checkin is this driver's start-of-day report, when they have made
	// one. Stops stay empty until it is approved — see handleDriverToday.
	Checkin *domain.Checkin `json:"checkin,omitempty"`
	// CheckinRequired says the round exists but is still behind the gate,
	// which is what tells the app to show the count form rather than an
	// empty list that looks like a quiet day.
	CheckinRequired bool `json:"checkin_required"`
}

// handleDriverToday is the single request the driver app makes on
// opening: the route assigned to this driver for the date, with every
// stop already ordered and carrying the customer details needed at the
// door. One round-trip, because it is made from a phone on a patchy
// connection at the start of a round.
func (s *Server) handleDriverToday(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	date, ok := resolveDate(sess.Business, r)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	assigned, err := s.routeForDriver(r, sess, date)
	if err != nil {
		writeStoreError(w, err, "route")
		return
	}
	if assigned == nil {
		// Not an error: a driver with nothing assigned yet is a normal
		// state on a quiet morning, and the app should say "no route
		// yet" rather than show a failure.
		writeJSON(w, http.StatusOK, driverTodayResponse{
			Date:     date,
			Stops:    []domain.Stop{},
			Captures: sess.Business.Config.StopCaptures,
		})
		return
	}

	// The gate. A round exists, but nothing about it is shown until
	// somebody at the farm has agreed the driver's count — see
	// checkin.go. Deliberately after the "is there a round at all" check
	// above, so a driver with nothing assigned is told that plainly
	// rather than being asked to count stock for a round that doesn't
	// exist.
	checkin, approved := s.checkinFor(r, sess, date)
	if !approved {
		var pending *domain.Checkin
		if checkin.ID != "" {
			pending = &checkin
		}
		writeJSON(w, http.StatusOK, driverTodayResponse{
			Date:            date,
			Route:           assigned,
			Stops:           []domain.Stop{},
			Captures:        sess.Business.Config.StopCaptures,
			Checkin:         pending,
			CheckinRequired: true,
		})
		return
	}

	orders, err := s.store.ListDailyOrders(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "deliveries")
		return
	}

	mine := []domain.DailyOrder{}
	for _, o := range orders {
		if o.RouteID != nil && *o.RouteID == assigned.ID {
			mine = append(mine, o)
		}
	}

	stops, err := s.buildStops(r, sess.Business.ID, mine)
	if err != nil {
		writeStoreError(w, err, "deliveries")
		return
	}

	remaining := 0
	for _, stop := range stops {
		if stop.Open() {
			remaining++
		}
	}

	writeJSON(w, http.StatusOK, driverTodayResponse{
		Date:      date,
		Route:     assigned,
		Stops:     stops,
		Remaining: remaining,
		Captures:  sess.Business.Config.StopCaptures,
		Checkin:   &checkin,
	})
}

// routeForDriver finds the route assigned to the calling driver on a
// date, or nil. Returns the first match: V1 assigns one route per driver
// per day, and splitting a driver's morning across two routes is a
// scheduling feature, not something to half-support here.
func (s *Server) routeForDriver(r *http.Request, sess session, date string) (*domain.Route, error) {
	routes, err := s.store.ListRoutes(r.Context(), sess.Business.ID, date)
	if err != nil {
		return nil, err
	}
	for i := range routes {
		if routes[i].DriverID != nil && *routes[i].DriverID == sess.User.ID {
			return &routes[i], nil
		}
	}
	return nil, nil
}

// handleDriverStopStatus records the outcome at a door. A driver may only
// report delivered or failed: skipping is a decision made in advance by
// the admin or (later) the customer, and letting a driver mark a stop
// "skipped" would blur the one distinction that makes the daily numbers
// worth reading.
func (s *Server) handleDriverStopStatus(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Status   string             `json:"status"`
		Note     string             `json:"note"`
		Captures domain.FieldValues `json:"captures"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	status := domain.DeliveryStatus(strings.TrimSpace(req.Status))
	if status != domain.StatusDelivered && status != domain.StatusFailed {
		writeError(w, http.StatusBadRequest, "status must be delivered or failed", "invalid_status")
		return
	}

	order, err := s.store.GetDailyOrder(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "delivery")
		return
	}

	// A driver may only touch stops on their own route. The tenant check
	// in the store already stops cross-business access; this stops one
	// driver closing another's deliveries.
	assigned, err := s.routeForDriver(r, sess, order.DeliveryDate)
	if err != nil {
		writeStoreError(w, err, "route")
		return
	}
	if assigned == nil || order.RouteID == nil || *order.RouteID != assigned.ID {
		writeError(w, http.StatusForbidden, "that delivery is not on your route", "not_your_stop")
		return
	}

	// Captures are validated against what this business declared for
	// *this outcome* — a school's "handed to" is required on a delivery
	// and meaningless on a failure. Validation happens before anything is
	// written, so a stop is never left half-closed with a required value
	// missing.
	captures, err := domain.ValidateCaptures(sess.Business.Config.StopCaptures, status, req.Captures)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error(), "missing_capture")
		return
	}

	now := time.Now().UTC()
	order.Status = status
	order.CompletedAt = &now
	order.Captures = captures
	if note := strings.TrimSpace(req.Note); note != "" {
		order.Note = note
	}

	updated, err := s.store.UpdateDailyOrder(r.Context(), order)
	if err != nil {
		writeStoreError(w, err, "delivery")
		return
	}

	s.recordEvent(r, sess, updated, "driver update")
	s.advanceRouteStatus(r, sess, *assigned)

	writeJSON(w, http.StatusOK, updated)
}

// advanceRouteStatus moves a route to in_progress on its first completed
// stop and to completed once nothing is left open, so an admin watching
// the dashboard sees the round's state without the driver having to press
// "start" or "finish" — two taps a driver would forget on a cold morning.
func (s *Server) advanceRouteStatus(r *http.Request, sess session, assigned domain.Route) {
	orders, err := s.store.ListDailyOrders(r.Context(), sess.Business.ID, assigned.RouteDate)
	if err != nil {
		log.Printf("advance route status: %v", err)
		return
	}

	total, open := 0, 0
	for _, o := range orders {
		if o.RouteID == nil || *o.RouteID != assigned.ID {
			continue
		}
		total++
		if o.Open() {
			open++
		}
	}

	next := assigned.Status
	switch {
	case total > 0 && open == 0:
		next = domain.RouteCompleted
	case assigned.Status == domain.RouteDraft || assigned.Status == domain.RouteAssigned:
		next = domain.RouteInProgress
	}
	if next == assigned.Status {
		return
	}

	assigned.Status = next
	if _, err := s.store.UpdateRoute(r.Context(), assigned); err != nil {
		log.Printf("advance route status: %v", err)
	}
}
