package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"delivery-manager/internal/auth"
	"delivery-manager/internal/config"
	"delivery-manager/internal/domain"
	"delivery-manager/internal/notify"
	"delivery-manager/internal/ratelimit"
	"delivery-manager/internal/storage"
)

// driverLoginLimit/driverLoginWindow bound PIN guessing per phone number.
// A 6-digit PIN is only a million wide, so the rate limit — not the
// secret's entropy — is what actually makes it safe; 10 attempts an hour
// leaves a legitimate driver plenty of room to fumble a cold morning
// login while making exhaustive search hopeless.
const (
	driverLoginLimit  = 10
	driverLoginWindow = time.Hour
)

// maxRequestBytes caps request bodies. Every payload this API accepts is
// a small JSON object; the limit exists so a malformed or hostile client
// can't make the server buffer something large.
const maxRequestBytes = 256 * 1024

type Server struct {
	store storage.Store
	auth  *auth.Service
	mux   *http.ServeMux

	defaultTimezone string
	// devLoginEnabled gates POST /api/v1/auth/dev-login, which mints an
	// admin session (creating a demo business on first use) without any
	// Google token. Never true when APP_ENV=prod; the route 404s outright
	// when disabled rather than existing-but-403ing, so it doesn't
	// advertise a backdoor.
	devLoginEnabled bool
	driverLogins    *ratelimit.Limiter
	// otpLimiter caps how often a code can be *asked for* per phone
	// number — the control that stops this being used to text someone
	// repeatedly, and to run up an SMS bill once a real provider is
	// wired. Verifying is limited separately by the per-code attempt
	// count (see auth.OTPMaxAttempts).
	otpLimiter *ratelimit.Limiter
	otpSender  notify.Sender
}

func NewServer(store storage.Store, authService *auth.Service, cfg config.Config) *Server {
	s := &Server{
		store:           store,
		auth:            authService,
		mux:             http.NewServeMux(),
		defaultTimezone: cfg.DefaultTimezone,
		devLoginEnabled: cfg.Environment != config.EnvironmentProd,
		driverLogins:    ratelimit.New(driverLoginLimit, driverLoginWindow),
		otpLimiter:      ratelimit.New(otpRequestBurst, otpRequestWindow),
		otpSender:       notify.New(string(cfg.Environment), cfg.AllowLogOTPSender),
	}
	s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	writeCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	s.mux.ServeHTTP(w, r)
}

// routes uses Go 1.22 method-and-wildcard ServeMux patterns rather than
// the prefix-match-plus-manual-path-parsing style of the older
// 3VNSYSTEMS products. Those products predate the enhanced mux; there is
// no reason for a new module on Go 1.24 to hand-roll segment parsing and
// method dispatch that the standard library now does.
func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", s.handleHealth)

	// One door for everyone: a phone number, then the code sent to it.
	// The owner's Google sign-in and the driver's admin-issued PIN both
	// used to live here; see otpauth.go for why neither survived.
	s.mux.HandleFunc("POST /api/v1/auth/otp/request", s.handleRequestOTP)
	s.mux.HandleFunc("POST /api/v1/auth/otp/verify", s.handleVerifyOTP)
	if s.devLoginEnabled {
		s.mux.HandleFunc("POST /api/v1/auth/dev-login", s.handleDevLogin)
	}
	s.mux.HandleFunc("GET /api/v1/auth/me", s.withAuth(s.handleMe))

	s.mux.HandleFunc("GET /api/v1/config", s.withAuth(s.handleGetConfig))
	s.mux.HandleFunc("PUT /api/v1/config", s.withAdmin(s.handleUpdateConfig))
	s.mux.HandleFunc("PATCH /api/v1/business", s.withAdmin(s.handleUpdateBusiness))

	s.mux.HandleFunc("GET /api/v1/service-areas", s.withAdmin(s.handleListServiceAreas))
	s.mux.HandleFunc("GET /api/v1/service-areas/suggest", s.withAdmin(s.handleSuggestServiceAreas))
	s.mux.HandleFunc("POST /api/v1/service-areas", s.withAdmin(s.handleCreateServiceArea))
	s.mux.HandleFunc("POST /api/v1/service-areas/{id}/drivers", s.withAdmin(s.handleSetAreaDrivers))
	s.mux.HandleFunc("PATCH /api/v1/service-areas/{id}", s.withAdmin(s.handleUpdateServiceArea))

	s.mux.HandleFunc("GET /api/v1/customers", s.withAdmin(s.handleListCustomers))
	s.mux.HandleFunc("POST /api/v1/customers", s.withAdmin(s.handleCreateCustomer))
	s.mux.HandleFunc("PATCH /api/v1/customers/{id}", s.withAdmin(s.handleUpdateCustomer))

	s.mux.HandleFunc("GET /api/v1/products", s.withAdmin(s.handleListProducts))
	s.mux.HandleFunc("POST /api/v1/products", s.withAdmin(s.handleCreateProduct))
	s.mux.HandleFunc("PATCH /api/v1/products/{id}", s.withAdmin(s.handleUpdateProduct))
	s.mux.HandleFunc("GET /api/v1/products/demand", s.withAdmin(s.handleProductDemand))

	s.mux.HandleFunc("GET /api/v1/drivers", s.withAdmin(s.handleListDrivers))
	s.mux.HandleFunc("POST /api/v1/drivers", s.withAdmin(s.handleCreateDriver))
	s.mux.HandleFunc("POST /api/v1/drivers/{id}/active", s.withAdmin(s.handleSetDriverActive))
	s.mux.HandleFunc("POST /api/v1/drivers/{id}/home", s.withAdmin(s.handleSetDriverHome))
	s.mux.HandleFunc("POST /api/v1/drivers/{id}/finish", s.withAdmin(s.handleSetDriverFinish))

	s.mux.HandleFunc("GET /api/v1/recurring-orders", s.withAdmin(s.handleListRecurringOrders))
	s.mux.HandleFunc("POST /api/v1/recurring-orders", s.withAdmin(s.handleCreateRecurringOrder))
	s.mux.HandleFunc("POST /api/v1/recurring-orders/{id}/active", s.withAdmin(s.handleSetRecurringActive))

	s.mux.HandleFunc("GET /api/v1/day", s.withAdmin(s.handleGetDay))
	s.mux.HandleFunc("POST /api/v1/day/generate", s.withAdmin(s.handleGenerateDay))
	s.mux.HandleFunc("POST /api/v1/orders", s.withAdmin(s.handleCreateAdHocOrder))
	s.mux.HandleFunc("PATCH /api/v1/orders/{id}", s.withAdmin(s.handleOverrideOrder))

	s.mux.HandleFunc("GET /api/v1/routes", s.withAdmin(s.handleListRoutes))
	s.mux.HandleFunc("POST /api/v1/routes", s.withAdmin(s.handleBuildRoute))
	s.mux.HandleFunc("POST /api/v1/routes/plan", s.withAdmin(s.handlePlanRounds))
	s.mux.HandleFunc("PATCH /api/v1/orders/{id}/route", s.withAdmin(s.handleMoveStop))
	s.mux.HandleFunc("POST /api/v1/orders/{id}/position", s.withAdmin(s.handleMoveStopPosition))
	s.mux.HandleFunc("DELETE /api/v1/routes/{id}", s.withAdmin(s.handleDeleteRoute))
	s.mux.HandleFunc("POST /api/v1/routes/reset", s.withAdmin(s.handleResetRoutes))
	s.mux.HandleFunc("POST /api/v1/routes/{id}/assign", s.withAdmin(s.handleAssignRoute))

	s.mux.HandleFunc("GET /api/v1/driver/today", s.withDriver(s.handleDriverToday))
	s.mux.HandleFunc("POST /api/v1/driver/stops/{id}/status", s.withDriver(s.handleDriverStopStatus))
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ---------- session plumbing ----------

type contextKey string

const sessionContextKey contextKey = "session"

// session is the resolved caller: the live user record and the business
// they belong to, both loaded fresh from the store on every request.
// Loading rather than trusting the token's copy is what makes
// deactivating a driver take effect immediately — a stolen handset stops
// working at its next request instead of whenever its long-lived token
// happens to expire.
type session struct {
	User     domain.User
	Business domain.Business
}

func sessionFrom(ctx context.Context) session {
	s, _ := ctx.Value(sessionContextKey).(session)
	return s
}

// refreshTokenAfter is how stale a token has to be before an
// authenticated request mints a replacement. A day means a daily user is
// re-issued once a day and never sees a sign-in screen, while the header
// is absent from the overwhelming majority of requests.
const refreshTokenAfter = 24 * time.Hour

func (s *Server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		tokenString := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		if authHeader == "" || tokenString == authHeader {
			writeError(w, http.StatusUnauthorized, "sign in required", "signin_required")
			return
		}

		claims, err := s.auth.ParseToken(tokenString)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid or expired session", "invalid_token")
			return
		}

		user, err := s.store.GetUserByID(r.Context(), claims.BusinessID, claims.UserID)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid or expired session", "invalid_token")
			return
		}
		if !user.Active {
			writeError(w, http.StatusForbidden, "this account has been deactivated", "account_deactivated")
			return
		}

		business, err := s.store.GetBusiness(r.Context(), user.BusinessID)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid or expired session", "invalid_token")
			return
		}

		// Sliding session. Sign-in costs an SMS now, so the token is
		// renewed whenever it is more than refreshTokenAfter old and
		// still valid: someone using the app keeps their session
		// indefinitely, and the code screen only comes back after a real
		// absence. The new token rides on a response header rather than
		// the body, so every endpoint gets this for free without any of
		// them knowing about it.
		if claims.IssuedAt != nil && time.Since(claims.IssuedAt.Time) > refreshTokenAfter {
			if fresh, err := s.auth.IssueToken(user); err == nil {
				w.Header().Set("X-Refreshed-Token", fresh)
				w.Header().Add("Access-Control-Expose-Headers", "X-Refreshed-Token")
			} else {
				// Not fatal: the request is authenticated either way, and
				// the caller keeps the token it already has.
				log.Printf("refresh token for %s: %v", user.ID, err)
			}
		}

		ctx := context.WithValue(r.Context(), sessionContextKey, session{User: user, Business: business})
		next(w, r.WithContext(ctx))
	}
}

func (s *Server) withAdmin(next http.HandlerFunc) http.HandlerFunc {
	return s.withAuth(func(w http.ResponseWriter, r *http.Request) {
		if !sessionFrom(r.Context()).User.Role.CanAdmin() {
			writeError(w, http.StatusForbidden, "this action needs an admin account", "admin_required")
			return
		}
		next(w, r)
	})
}

func (s *Server) withDriver(next http.HandlerFunc) http.HandlerFunc {
	return s.withAuth(func(w http.ResponseWriter, r *http.Request) {
		// RoleAdminDriver passes both this and withAdmin: a one-person
		// dairy is the owner driving their own van, and making them keep
		// two accounts to do the two halves of their own job would be a
		// bug, not a safeguard.
		if !sessionFrom(r.Context()).User.Role.CanDrive() {
			writeError(w, http.StatusForbidden, "this action needs a driver account", "driver_required")
			return
		}
		next(w, r)
	})
}

// ---------- auth handlers ----------

type authResponse struct {
	Token    string          `json:"token,omitempty"`
	User     domain.User     `json:"user"`
	Business domain.Business `json:"business"`
}

// createBusinessWithAdmin creates the tenant, its first admin, and the
// vertical's starting configuration and product catalogue.
//
// Everything the vertical contributes comes from domain.PresetFor and is
// copied into the tenant, not referenced: from this moment the business
// owns its own config and can diverge from its vertical freely. That copy
// is the whole extensibility story — see Docs/ARCHITECTURE.md.
// createBusinessWithOwnerPhone is the signup path now that the owner is
// identified by a proven phone number rather than a Google account.
func (s *Server) createBusinessWithOwnerPhone(ctx context.Context, name string, businessType domain.BusinessType, timezone string, phone string, ownerName string) (domain.Business, domain.User, error) {
	return s.createBusiness(ctx, name, businessType, timezone, "", phone, ownerName)
}

// createBusinessWithAdmin keeps the email-identified path, which only
// dev-login uses now — it needs a stable identity that isn't a phone
// number so repeated demo logins land on the same business.
func (s *Server) createBusinessWithAdmin(ctx context.Context, name string, businessType domain.BusinessType, timezone string, email string, adminName string) (domain.Business, domain.User, error) {
	return s.createBusiness(ctx, name, businessType, timezone, email, "", adminName)
}

func (s *Server) createBusiness(ctx context.Context, name string, businessType domain.BusinessType, timezone string, email string, phone string, adminName string) (domain.Business, domain.User, error) {
	preset := domain.PresetFor(businessType)
	business := domain.Business{
		ID:       domain.NewID(),
		Name:     name,
		Type:     businessType,
		Timezone: timezone,
		Config:   preset.Config,
	}
	if strings.TrimSpace(adminName) == "" {
		adminName = email
		if adminName == "" {
			adminName = phone
		}
	}
	admin := domain.User{
		ID:    domain.NewID(),
		Role:  domain.RoleAdminDriver,
		Name:  adminName,
		Email: email,
		Phone: phone,
	}

	business, admin, err := s.store.CreateBusiness(ctx, business, admin)
	if err != nil {
		return domain.Business{}, domain.User{}, err
	}

	for _, spec := range preset.Products {
		product := domain.Product{
			ID:         domain.NewID(),
			BusinessID: business.ID,
			Name:       spec.Name,
			Unit:       spec.Unit,
			Active:     true,
		}
		if _, err := s.store.CreateProduct(ctx, product); err != nil {
			// A missing starter product is cosmetic — the admin can add
			// their own — so it must not fail a signup that has already
			// created the business and its owner.
			log.Printf("signup: seed product %q: %v", product.Name, err)
		}
	}
	return business, admin, nil
}

func demoBusinessName(businessType domain.BusinessType) string {
	switch businessType {
	case domain.BusinessTypeSchool:
		return "Demo School Transport"
	case domain.BusinessTypeWater:
		return "Demo Water Supply"
	case domain.BusinessTypeGrocery:
		return "Demo Grocery"
	default:
		return "Demo Dairy"
	}
}

// handleDevLogin mints an admin session against a demo business, creating
// both on first use. Local/dev only (see devLoginEnabled) — it exists so
// the whole admin-and-driver flow can be exercised before a Google client
// ID is configured.
func (s *Server) handleDevLogin(w http.ResponseWriter, r *http.Request) {
	const devEmail = "dev@local.test"

	// business_type is optional and only takes effect the first time,
	// when the demo business is created. It exists so a vertical other
	// than dairy — a school run, with its own vocabulary, custom fields
	// and doorstep captures — can be exercised locally without wiring up
	// Google Sign-In first.
	var req struct {
		BusinessType string `json:"business_type"`
	}
	// A missing or empty body is the normal case here, so a decode
	// failure is not an error — it just means "use the defaults".
	_ = json.NewDecoder(r.Body).Decode(&req)

	businessType := domain.BusinessType(strings.ToLower(strings.TrimSpace(req.BusinessType)))
	if !domain.ValidBusinessType(businessType) {
		businessType = domain.BusinessTypeDairy
	}

	user, err := s.store.GetAdminByEmail(r.Context(), devEmail)
	if err == nil {
		business, err := s.store.GetBusiness(r.Context(), user.BusinessID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not create dev session", "")
			return
		}
		s.respondWithSession(w, user, business)
		return
	}
	if !errors.Is(err, storage.ErrNotFound) {
		log.Printf("dev-login: %v", err)
		writeError(w, http.StatusInternalServerError, "could not create dev session", "")
		return
	}

	business, admin, err := s.createBusinessWithAdmin(r.Context(), demoBusinessName(businessType), businessType, s.defaultTimezone, devEmail, "Local Dev")
	if err != nil {
		log.Printf("dev-login: create business: %v", err)
		writeError(w, http.StatusInternalServerError, "could not create dev session", "")
		return
	}
	s.respondWithSession(w, admin, business)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	writeJSON(w, http.StatusOK, authResponse{User: sess.User, Business: sess.Business})
}

func (s *Server) respondWithSession(w http.ResponseWriter, user domain.User, business domain.Business) {
	token, err := s.auth.IssueToken(user)
	if err != nil {
		log.Printf("issue token: %v", err)
		writeError(w, http.StatusInternalServerError, "could not issue session token", "")
		return
	}
	writeJSON(w, http.StatusOK, authResponse{Token: token, User: user, Business: business})
}

// ---------- shared helpers ----------

type errorResponse struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

var allowedOrigin = "*"

func SetAllowedOrigin(origin string) {
	if origin != "" {
		allowedOrigin = origin
	}
}

func writeCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
	if allowedOrigin != "*" {
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
}

func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	writeCORSHeaders(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, message string, code string) {
	writeJSON(w, status, errorResponse{Error: message, Code: code})
}

// decodeJSON reads and validates the request body, writing a 400 and
// returning false if it isn't usable — so handlers can `if !decodeJSON(...)
// { return }` instead of repeating the same error plumbing.
func decodeJSON(w http.ResponseWriter, r *http.Request, target interface{}) bool {
	if err := json.NewDecoder(r.Body).Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "request body must be valid JSON", "invalid_json")
		return false
	}
	return true
}

// writeStoreError maps a storage error onto a status code, so every
// handler reports a missing record the same way instead of leaking
// internals on one path and 500ing on another.
func writeStoreError(w http.ResponseWriter, err error, what string) {
	switch {
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, what+" was not found", "not_found")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, what+" already exists", "conflict")
	default:
		log.Printf("%s: %v", what, err)
		writeError(w, http.StatusInternalServerError, "something went wrong", "")
	}
}

// resolveDate returns the date a request is about: an explicit ?date=
// query parameter, or today in the business's own timezone. Rejecting a
// malformed date rather than silently falling back to today matters —
// silently operating on the wrong day is how a driver ends up delivering
// yesterday's list.
func resolveDate(business domain.Business, r *http.Request) (string, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("date"))
	if raw == "" {
		return business.Today(), true
	}
	if _, err := time.Parse(domain.DateLayout, raw); err != nil {
		return "", false
	}
	return raw, true
}
