package httpapi

import (
	"errors"
	"log"
	"net/http"

	"delivery-manager/internal/auth"
	"delivery-manager/internal/domain"
	"delivery-manager/internal/storage"
)

// Signing in with a password.
//
// The door the product was designed around is a one-time code sent to a
// phone (otpauth.go), and it is still here and still works. It cannot be
// *delivered* until an SMS provider is configured, so this is the door
// that is actually open — see auth/password.go for what that costs.
//
// Same identity either way: the phone number is the username. A driver
// already knows their own number, it is already unique across the
// system, and adding a second name to remember would be one more thing
// to lose.
//
// There is no sign-up here on purpose. The product serves one business
// while it is being shaped around them, so accounts are created for
// people — the owner's by whoever sets the deployment up, and each
// driver's by the owner (handleCreateDriver, and handleSetDriverPassword
// below). Self-serve signup is the OTP path's job, and it comes back
// with it.

func (s *Server) handlePasswordSignIn(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone    string `json:"phone"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	phone := domain.NormalizePhone(req.Phone)
	if !domain.ValidPhone(phone) {
		writeError(w, http.StatusBadRequest, "that doesn't look like a phone number", "invalid_phone")
		return
	}
	// The same limiter the one-time code path uses, for the same reason:
	// a password is guessable in a way a fresh six-digit code is not, so
	// this is the control that stops someone trying thousands of them.
	if !s.driverLogins.Allow(phone) {
		writeError(w, http.StatusTooManyRequests,
			"too many attempts for this number — wait a few minutes and try again", "rate_limited")
		return
	}

	user, err := s.store.GetUserByPhone(r.Context(), phone)
	if err != nil && !errors.Is(err, storage.ErrNotFound) {
		log.Printf("password sign-in: load user: %v", err)
		writeError(w, http.StatusInternalServerError, "could not sign you in", "")
		return
	}
	// One message whether the number is unknown or the password is
	// wrong, so this cannot be used to find out who has an account.
	if errors.Is(err, storage.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "that number and password don't match", "bad_credentials")
		return
	}
	if !user.Active {
		writeError(w, http.StatusForbidden, "that account has been deactivated", "account_inactive")
		return
	}

	hash, err := s.store.GetUserPasswordHash(r.Context(), user.ID)
	if err != nil {
		log.Printf("password sign-in: load hash: %v", err)
		writeError(w, http.StatusInternalServerError, "could not sign you in", "")
		return
	}
	if err := auth.CheckPassword(hash, req.Password); err != nil {
		writeError(w, http.StatusUnauthorized, "that number and password don't match", "bad_credentials")
		return
	}

	business, err := s.store.GetBusiness(r.Context(), user.BusinessID)
	if err != nil {
		log.Printf("password sign-in: load business: %v", err)
		writeError(w, http.StatusInternalServerError, "could not sign you in", "")
		return
	}
	log.Printf("signed in %s", user.ID)
	s.respondWithSession(w, user, business)
}

// handleChangePassword changes your own, and requires the current one —
// so a phone left unlocked on a seat cannot be used to lock its owner
// out of their own business.
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := auth.ValidatePassword(req.NewPassword); err != nil {
		writeError(w, http.StatusBadRequest, err.Error(), "invalid_password")
		return
	}

	hash, err := s.store.GetUserPasswordHash(r.Context(), sess.User.ID)
	if err != nil {
		writeStoreError(w, err, "account")
		return
	}
	// An account that has never had one — a driver created before this
	// existed — sets it rather than changing it. Refusing would strand
	// them, since there is no other way in.
	if hash != "" {
		if err := auth.CheckPassword(hash, req.CurrentPassword); err != nil {
			writeError(w, http.StatusUnauthorized, "that isn't your current password", "bad_credentials")
			return
		}
	}

	next, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		log.Printf("change password: hash: %v", err)
		writeError(w, http.StatusInternalServerError, "could not change your password", "")
		return
	}
	if err := s.store.SetUserPassword(r.Context(), sess.Business.ID, sess.User.ID, next); err != nil {
		writeStoreError(w, err, "account")
		return
	}

	log.Printf("password changed for %s", sess.User.ID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleSetDriverPassword lets the owner set one for a driver.
//
// Without a way to send anything anywhere, somebody has to be able to
// hand a driver their first password and a new one when they forget it,
// and that somebody is the person who employs them. The owner can
// already deactivate a driver outright, so this grants no reach they
// didn't have.
func (s *Server) handleSetDriverPassword(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		writeError(w, http.StatusBadRequest, err.Error(), "invalid_password")
		return
	}

	driver, err := s.store.GetUserByID(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "driver")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		log.Printf("set driver password: hash: %v", err)
		writeError(w, http.StatusInternalServerError, "could not set that password", "")
		return
	}
	if err := s.store.SetUserPassword(r.Context(), sess.Business.ID, driver.ID, hash); err != nil {
		writeStoreError(w, err, "driver")
		return
	}

	log.Printf("password set for %s by %s", driver.ID, sess.User.ID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
