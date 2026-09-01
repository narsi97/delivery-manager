package httpapi

import (
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"delivery-manager/internal/auth"
	"delivery-manager/internal/domain"
	"delivery-manager/internal/storage"
)

// Signing in, for everyone.
//
// A phone number and a code sent to it — that is the whole scheme, for
// the owner and the driver alike. What it replaces is worth naming: the
// owner used to need a Google account, which is a strange thing to
// require of someone running a dairy from a phone; the driver used to
// need a 6-digit PIN their employer issued, told them, and had to reset
// whenever they forgot it. Neither party has a password now, so neither
// can have a weak one, reuse one, or be phished for one.
//
// The cost of passwordless is an SMS per sign-in, so sessions are long
// (see auth.Service and the sliding refresh in the auth middleware): a
// person using the app daily is not asked again, and only a real absence
// brings the code screen back.

// otpRequestWindow / otpRequestBurst rate-limit *asking* for a code, per
// phone number. This is the control that stops the endpoint being used to
// text someone repeatedly, and — since every message costs money once a
// real provider is wired — to run up a bill.
const (
	otpRequestBurst  = 3
	otpRequestWindow = 15 * time.Minute
)

type otpRequestBody struct {
	Phone string `json:"phone"`
	// Present for signup only. Collected before the number is proven and
	// held on the challenge, so that nothing is written to the businesses
	// table until the code comes back correct.
	BusinessName string `json:"business_name"`
	BusinessType string `json:"business_type"`
	OwnerName    string `json:"owner_name"`
}

// handleRequestOTP sends a code to a phone number, for either signing up
// a new business or signing back in to an existing account.
//
// It works out which of those it is rather than being told: a number that
// already has an account is a sign-in, one that doesn't is a signup. The
// client says what it *intends*, and the two only have to agree in the
// direction that matters — asking to sign in on an unknown number is an
// error worth showing ("no account for this number"), while asking to
// sign up on a known one is not, because a returning owner tapping the
// wrong button should just be signed in.
func (s *Server) handleRequestOTP(w http.ResponseWriter, r *http.Request) {
	var req otpRequestBody
	if !decodeJSON(w, r, &req) {
		return
	}

	phone := domain.NormalizePhone(req.Phone)
	if !domain.ValidPhone(phone) {
		writeError(w, http.StatusBadRequest, "that doesn't look like a phone number", "invalid_phone")
		return
	}

	if !s.otpLimiter.Allow(phone) {
		writeError(w, http.StatusTooManyRequests,
			"too many codes requested for this number — wait a few minutes and try again", "rate_limited")
		return
	}

	existing, err := s.store.GetUserByPhone(r.Context(), phone)
	switch {
	case err == nil && !existing.Active:
		// Deactivating a driver has to actually lock them out, including
		// out of the front door. Same reasoning as the auth middleware
		// reloading the user on every request.
		writeError(w, http.StatusForbidden, "that account has been deactivated", "account_inactive")
		return
	case err != nil && !errors.Is(err, storage.ErrNotFound):
		log.Printf("otp request: look up %s: %v", phone, err)
		writeError(w, http.StatusInternalServerError, "could not send a code", "")
		return
	}
	known := err == nil

	purpose := domain.OTPPurposeSignIn
	challenge := domain.OTPChallenge{Phone: phone}
	if !known {
		// No account: this can only be a signup, and it needs the
		// business details up front so there is something to create when
		// the code comes back.
		purpose = domain.OTPPurposeSignup
		name := strings.TrimSpace(req.BusinessName)
		if name == "" {
			writeError(w, http.StatusNotFound,
				"no account for that number yet — sign up to create one", "no_account")
			return
		}
		businessType := domain.BusinessType(strings.ToLower(strings.TrimSpace(req.BusinessType)))
		if businessType == "" {
			businessType = domain.BusinessTypeDairy
		}
		if !domain.ValidBusinessType(businessType) {
			writeError(w, http.StatusBadRequest, "that isn't a kind of business this app knows", "invalid_business_type")
			return
		}
		challenge.BusinessName = name
		challenge.BusinessType = businessType
		challenge.OwnerName = strings.TrimSpace(req.OwnerName)
	}

	code, err := auth.GenerateOTP()
	if err != nil {
		log.Printf("otp request: generate: %v", err)
		writeError(w, http.StatusInternalServerError, "could not send a code", "")
		return
	}
	hash, err := auth.HashOTP(code)
	if err != nil {
		log.Printf("otp request: hash: %v", err)
		writeError(w, http.StatusInternalServerError, "could not send a code", "")
		return
	}

	now := time.Now().UTC()
	challenge.CodeHash = hash
	challenge.Purpose = purpose
	challenge.CreatedAt = now
	challenge.ExpiresAt = now.Add(auth.OTPExpiry)

	if err := s.store.PutOTPChallenge(r.Context(), challenge); err != nil {
		log.Printf("otp request: store: %v", err)
		writeError(w, http.StatusInternalServerError, "could not send a code", "")
		return
	}

	// Sent after the challenge is stored, never before: a code someone
	// has received but the server has no record of is the one failure
	// that looks like the product is broken.
	if err := s.otpSender.SendOTP(r.Context(), phone, code); err != nil {
		log.Printf("otp request: send to %s: %v", phone, err)
		writeError(w, http.StatusServiceUnavailable,
			"could not send the code right now — try again in a moment", "send_failed")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"purpose":    purpose,
		"expires_in": int(auth.OTPExpiry.Seconds()),
		"phone":      phone,
		"is_new":     !known,
	})
}

// handleVerifyOTP exchanges a correct code for a session, creating the
// business and its first admin if this was a signup.
func (s *Server) handleVerifyOTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone string `json:"phone"`
		Code  string `json:"code"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	phone := domain.NormalizePhone(req.Phone)
	// Format is checked before anything is loaded, so a mistyped code
	// costs neither a database round-trip nor one of the five attempts.
	if err := auth.ValidateOTPFormat(req.Code); err != nil {
		writeError(w, http.StatusBadRequest, err.Error(), "invalid_code_format")
		return
	}

	challenge, err := s.store.GetOTPChallenge(r.Context(), phone)
	if errors.Is(err, storage.ErrNotFound) {
		writeError(w, http.StatusBadRequest, "ask for a new code", "no_challenge")
		return
	}
	if err != nil {
		log.Printf("otp verify: load challenge: %v", err)
		writeError(w, http.StatusInternalServerError, "could not check that code", "")
		return
	}

	now := time.Now().UTC()
	if challenge.Expired(now) {
		_ = s.store.DeleteOTPChallenge(r.Context(), phone)
		writeError(w, http.StatusBadRequest, "that code has expired — ask for a new one", "code_expired")
		return
	}
	if challenge.Attempts >= auth.OTPMaxAttempts {
		_ = s.store.DeleteOTPChallenge(r.Context(), phone)
		writeError(w, http.StatusTooManyRequests, "too many wrong tries — ask for a new code", "code_exhausted")
		return
	}

	if err := auth.CheckOTP(challenge.CodeHash, req.Code); err != nil {
		attempts, bumpErr := s.store.BumpOTPAttempts(r.Context(), phone)
		if bumpErr != nil {
			log.Printf("otp verify: bump attempts: %v", bumpErr)
		}
		// Burn the code once it has been guessed at enough times, rather
		// than leaving it alive for the rest of its five minutes.
		if attempts >= auth.OTPMaxAttempts {
			_ = s.store.DeleteOTPChallenge(r.Context(), phone)
			writeError(w, http.StatusTooManyRequests, "too many wrong tries — ask for a new code", "code_exhausted")
			return
		}
		writeError(w, http.StatusUnauthorized, "that code is not right", "invalid_code")
		return
	}

	// Correct. Consume it before issuing anything, so the same code can
	// never mint two sessions.
	if err := s.store.DeleteOTPChallenge(r.Context(), phone); err != nil {
		log.Printf("otp verify: consume challenge: %v", err)
		writeError(w, http.StatusInternalServerError, "could not complete sign-in", "")
		return
	}

	if challenge.Purpose == domain.OTPPurposeSignup {
		s.completeSignup(w, r, challenge)
		return
	}

	user, err := s.store.GetUserByPhone(r.Context(), phone)
	if err != nil {
		log.Printf("otp verify: load user: %v", err)
		writeError(w, http.StatusInternalServerError, "could not complete sign-in", "")
		return
	}
	if !user.Active {
		writeError(w, http.StatusForbidden, "that account has been deactivated", "account_inactive")
		return
	}
	business, err := s.store.GetBusiness(r.Context(), user.BusinessID)
	if err != nil {
		log.Printf("otp verify: load business: %v", err)
		writeError(w, http.StatusInternalServerError, "could not complete sign-in", "")
		return
	}
	s.respondWithSession(w, user, business)
}

// completeSignup creates the business and its owner, now that the number
// on the challenge has been proven.
//
// Anyone with a working phone number can do this today. That is a
// deliberate starting point, not an oversight: the alternative is a
// manual approval queue nobody is staffed to run, and an empty tenant
// created by a stranger costs nothing and reaches nobody. Verifying that
// a business is a real business is a later step, and one with a human in
// it.
func (s *Server) completeSignup(w http.ResponseWriter, r *http.Request, challenge domain.OTPChallenge) {
	ownerName := challenge.OwnerName
	if ownerName == "" {
		ownerName = "Owner"
	}

	business, admin, err := s.createBusinessWithOwnerPhone(
		r.Context(), challenge.BusinessName, challenge.BusinessType, s.defaultTimezone, challenge.Phone, ownerName)
	if errors.Is(err, storage.ErrConflict) {
		// The number gained an account between requesting the code and
		// using it. Signing them in is the right outcome — they own it.
		user, lookupErr := s.store.GetUserByPhone(r.Context(), challenge.Phone)
		if lookupErr == nil {
			if existing, bErr := s.store.GetBusiness(r.Context(), user.BusinessID); bErr == nil {
				s.respondWithSession(w, user, existing)
				return
			}
		}
		writeError(w, http.StatusConflict, "that number already has an account", "already_registered")
		return
	}
	if err != nil {
		log.Printf("signup: create business: %v", err)
		writeError(w, http.StatusInternalServerError, "could not create the account", "")
		return
	}

	log.Printf("signed up %s (%s) for %s", business.Name, business.Type, challenge.Phone)
	s.respondWithSession(w, admin, business)
}
