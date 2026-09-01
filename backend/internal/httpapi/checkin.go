package httpapi

import (
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"delivery-manager/internal/domain"
	"delivery-manager/internal/storage"
)

// The gate at the farm.
//
// A driver arrives, counts what is going on the van, and reports it. The
// day's stops stay hidden until somebody at the farm agrees with that
// count. The number is not the point — the agreement is. A driver who
// loads 38 packets against 40 addresses finds out two streets from the
// end; the same driver whose count was checked finds out while still
// standing next to more milk.
//
// It is deliberately not a lock on the *account*: a rejected count can be
// reported again, because a rejection is a correction and not a
// punishment. What it gates is one driver's view of one day.

// handleDriverCheckin is the driver reporting what they have loaded.
func (s *Server) handleDriverCheckin(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Units int    `json:"units"`
		Note  string `json:"note"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Units <= 0 {
		writeError(w, http.StatusBadRequest, "how many did you load?", "invalid_units")
		return
	}

	date, ok := resolveDate(sess.Business, r)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	// Reporting again replaces the previous attempt rather than queueing a
	// second — an admin should never be looking at two counts from one
	// driver for one morning and having to guess which is current.
	existing, err := s.store.GetCheckin(r.Context(), sess.Business.ID, sess.User.ID, date)
	if err != nil && !errors.Is(err, storage.ErrNotFound) {
		writeStoreError(w, err, "check-in")
		return
	}
	// Once approved, the count is settled. Letting a driver quietly revise
	// it afterwards would make the approval meaningless.
	if err == nil && existing.Approved() {
		writeError(w, http.StatusConflict,
			"your load has already been approved for today", "already_approved")
		return
	}

	id := domain.NewID()
	if err == nil {
		id = existing.ID
	}

	saved, err := s.store.PutCheckin(r.Context(), domain.Checkin{
		ID:         id,
		BusinessID: sess.Business.ID,
		DriverID:   sess.User.ID,
		RouteDate:  date,
		Units:      req.Units,
		Note:       strings.TrimSpace(req.Note),
		Status:     domain.CheckinPending,
		CreatedAt:  time.Now().UTC(),
	})
	if err != nil {
		writeStoreError(w, err, "check-in")
		return
	}
	log.Printf("check-in: %s reported %d units for %s", sess.User.Name, saved.Units, date)
	writeJSON(w, http.StatusOK, saved)
}

// handleListCheckins is the admin's queue for a day.
func (s *Server) handleListCheckins(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	date, ok := resolveDate(sess.Business, r)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}
	checkins, err := s.store.ListCheckins(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "check-ins")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"checkins": checkins, "date": date})
}

// handleReviewCheckin is the admin agreeing, or not.
func (s *Server) handleReviewCheckin(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Approve bool   `json:"approve"`
		Note    string `json:"note"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	date, ok := resolveDate(sess.Business, r)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	existing, err := s.store.GetCheckin(r.Context(), sess.Business.ID, r.PathValue("driverId"), date)
	if err != nil {
		writeStoreError(w, err, "check-in")
		return
	}

	// A rejection owes the driver a reason. "12 short" is something they
	// can act on standing at the farm; a bare no is not.
	note := strings.TrimSpace(req.Note)
	if !req.Approve && note == "" {
		writeError(w, http.StatusBadRequest,
			"say what's wrong with the count — the driver needs to know what to fix", "reason_required")
		return
	}

	now := time.Now().UTC()
	existing.Status = domain.CheckinApproved
	if !req.Approve {
		existing.Status = domain.CheckinRejected
	}
	existing.ReviewedBy = sess.User.Name
	existing.ReviewNote = note
	existing.ReviewedAt = &now

	saved, err := s.store.PutCheckin(r.Context(), existing)
	if err != nil {
		writeStoreError(w, err, "check-in")
		return
	}
	log.Printf("check-in: %s %s %s's %d units for %s",
		sess.User.Name, existing.Status, existing.DriverID, existing.Units, date)
	writeJSON(w, http.StatusOK, saved)
}

// checkinFor returns this driver's check-in for a date, and whether their
// round is unlocked. A business that has never used the feature has no
// check-ins at all, and its drivers must not be locked out by a gate
// nobody opened — so "no check-in exists" reports not-approved, and the
// driver screen offers the form rather than an empty round.
func (s *Server) checkinFor(r *http.Request, sess session, date string) (domain.Checkin, bool) {
	existing, err := s.store.GetCheckin(r.Context(), sess.Business.ID, sess.User.ID, date)
	if err != nil {
		return domain.Checkin{}, false
	}
	return existing, existing.Approved()
}
