package httpapi

import (
	"errors"
	"log"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"delivery-manager/internal/domain"
	"delivery-manager/internal/extensions"
	"delivery-manager/internal/route"
	"delivery-manager/internal/storage"
)

// ---------- business ----------

// handleUpdateBusiness edits the small set of plain scalar fields on the
// business record itself — name and home location. Config (vocabulary,
// custom fields, captures) has its own endpoint (handleUpdateConfig)
// because it replaces one whole document; this is PATCH-partial like
// handleUpdateCustomer instead, since name and location are independent.
func (s *Server) handleUpdateBusiness(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Name    string   `json:"name"`
		HomeLat *float64 `json:"home_lat"`
		HomeLng *float64 `json:"home_lng"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	existing := sess.Business
	if strings.TrimSpace(req.Name) != "" {
		existing.Name = strings.TrimSpace(req.Name)
	}
	// Both or neither — a lone lat with no lng would silently move the
	// pin to a broken location.
	if req.HomeLat != nil && req.HomeLng != nil {
		if !validCoordinates(*req.HomeLat, *req.HomeLng) {
			writeError(w, http.StatusBadRequest, "home_lat must be between -90 and 90 and home_lng between -180 and 180", "invalid_location")
			return
		}
		existing.HomeLat, existing.HomeLng = *req.HomeLat, *req.HomeLng
	}

	updated, err := s.store.UpdateBusiness(r.Context(), existing)
	if err != nil {
		writeStoreError(w, err, "business")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// ---------- customers ----------

type customerRequest struct {
	Name    string  `json:"name"`
	Phone   string  `json:"phone"`
	Address string  `json:"address"`
	Lat     float64 `json:"lat"`
	Lng     float64 `json:"lng"`
	Notes   string  `json:"notes"`
	// Empty on PATCH means "leave it alone", same as every other field
	// here — a customer's tier is not something a pin-drop should reset.
	Priority string `json:"priority"`
	Active   *bool  `json:"active"`
	// A pointer so that "absent" and "explicitly empty" stay
	// distinguishable on PATCH: omitting the key leaves the stored bag
	// alone, sending {} clears it.
	CustomFields *domain.FieldValues `json:"custom_fields"`
}

func (s *Server) handleListCustomers(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	customers, err := s.store.ListCustomers(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "customers")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"customers": customers})
}

func (s *Server) handleCreateCustomer(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req customerRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required", "missing_fields")
		return
	}
	if !validCoordinates(req.Lat, req.Lng) {
		writeError(w, http.StatusBadRequest, "lat must be between -90 and 90 and lng between -180 and 180", "invalid_location")
		return
	}

	submitted := domain.FieldValues{}
	if req.CustomFields != nil {
		submitted = *req.CustomFields
	}
	customFields, ok := s.customFieldsFor(w, sess, domain.TargetCustomer, submitted)
	if !ok {
		return
	}

	priority := domain.PriorityTier(strings.ToLower(strings.TrimSpace(req.Priority)))
	if !domain.ValidPriority(priority) {
		writeError(w, http.StatusBadRequest, "priority must be business, early or normal", "invalid_priority")
		return
	}

	customer := domain.Customer{
		ID:           domain.NewID(),
		BusinessID:   sess.Business.ID,
		Name:         strings.TrimSpace(req.Name),
		Phone:        strings.TrimSpace(req.Phone),
		Address:      strings.TrimSpace(req.Address),
		Lat:          req.Lat,
		Lng:          req.Lng,
		Notes:        strings.TrimSpace(req.Notes),
		Priority:     domain.NormalizePriority(priority),
		Active:       true,
		CustomFields: customFields,
	}
	created, err := s.store.CreateCustomer(r.Context(), customer)
	if err != nil {
		writeStoreError(w, err, "customer")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleUpdateCustomer(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	existing, err := s.store.GetCustomer(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "customer")
		return
	}

	var req customerRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	// PATCH semantics: an omitted field keeps its stored value. Sending
	// only {"lat":..,"lng":..} — which is what "drop the pin while
	// standing at the door" does — must not blank out the address.
	if strings.TrimSpace(req.Name) != "" {
		existing.Name = strings.TrimSpace(req.Name)
	}
	if strings.TrimSpace(req.Phone) != "" {
		existing.Phone = strings.TrimSpace(req.Phone)
	}
	if strings.TrimSpace(req.Address) != "" {
		existing.Address = strings.TrimSpace(req.Address)
	}
	if strings.TrimSpace(req.Notes) != "" {
		existing.Notes = strings.TrimSpace(req.Notes)
	}
	if req.Lat != 0 || req.Lng != 0 {
		if !validCoordinates(req.Lat, req.Lng) {
			writeError(w, http.StatusBadRequest, "lat must be between -90 and 90 and lng between -180 and 180", "invalid_location")
			return
		}
		existing.Lat = req.Lat
		existing.Lng = req.Lng
	}
	if strings.TrimSpace(req.Priority) != "" {
		priority := domain.PriorityTier(strings.ToLower(strings.TrimSpace(req.Priority)))
		if !domain.ValidPriority(priority) {
			writeError(w, http.StatusBadRequest, "priority must be business, early or normal", "invalid_priority")
			return
		}
		existing.Priority = domain.NormalizePriority(priority)
	}
	if req.Active != nil {
		existing.Active = *req.Active
	}
	if req.CustomFields != nil {
		// Replacement, not merge — the admin console edits the whole set
		// of declared fields as one form, so a partial merge would make
		// clearing a value impossible.
		customFields, ok := s.customFieldsFor(w, sess, domain.TargetCustomer, *req.CustomFields)
		if !ok {
			return
		}
		existing.CustomFields = customFields
	}

	updated, err := s.store.UpdateCustomer(r.Context(), existing)
	if err != nil {
		writeStoreError(w, err, "customer")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// validCoordinates also treats the exact 0,0 pair as "no pin set" rather
// than a location — see domain.Customer.HasPin. Null Island is in the
// Gulf of Guinea and is never a real delivery address.
func validCoordinates(lat, lng float64) bool {
	return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

// ---------- products ----------

func (s *Server) handleListProducts(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	products, err := s.store.ListProducts(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "products")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"products": products})
}

func (s *Server) handleCreateProduct(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Name       string `json:"name"`
		Unit       string `json:"unit"`
		PriceCents int    `json:"price_cents"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required", "missing_fields")
		return
	}
	if req.PriceCents < 0 {
		writeError(w, http.StatusBadRequest, "price_cents cannot be negative", "invalid_price")
		return
	}

	created, err := s.store.CreateProduct(r.Context(), domain.Product{
		ID:         domain.NewID(),
		BusinessID: sess.Business.ID,
		Name:       strings.TrimSpace(req.Name),
		Unit:       strings.TrimSpace(req.Unit),
		PriceCents: req.PriceCents,
		Active:     true,
	})
	if err != nil {
		writeStoreError(w, err, "product")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// handleUpdateProduct edits a product a business already sells — its
// price, its unit, how much is in stock, and whether it is still on the
// list. Products were create-and-list only until now, which meant a
// business that set up "Milk 1L" before it had settled on a price could
// never put one on it.
//
// PATCH-partial like the customer and business handlers: an omitted
// field keeps its stored value, so the stock control can send only a
// stock number without needing to know the price.
func (s *Server) handleUpdateProduct(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	existing, err := s.store.GetProduct(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "product")
		return
	}

	var req struct {
		Name string `json:"name"`
		Unit string `json:"unit"`
		// Pointers so that "not sent" and "explicitly zero" stay
		// distinguishable — setting a price to nothing, or stock to none,
		// are both real things to want.
		PriceCents    *int     `json:"price_cents"`
		StockQuantity *float64 `json:"stock_quantity"`
		Active        *bool    `json:"active"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	if strings.TrimSpace(req.Name) != "" {
		existing.Name = strings.TrimSpace(req.Name)
	}
	if strings.TrimSpace(req.Unit) != "" {
		existing.Unit = strings.TrimSpace(req.Unit)
	}
	if req.PriceCents != nil {
		if *req.PriceCents < 0 {
			writeError(w, http.StatusBadRequest, "price_cents cannot be negative", "invalid_price")
			return
		}
		existing.PriceCents = *req.PriceCents
	}
	if req.StockQuantity != nil {
		if *req.StockQuantity < 0 {
			writeError(w, http.StatusBadRequest, "stock cannot be negative", "invalid_stock")
			return
		}
		existing.StockQuantity = *req.StockQuantity
	}
	if req.Active != nil {
		existing.Active = *req.Active
	}

	updated, err := s.store.UpdateProduct(r.Context(), existing)
	if err != nil {
		writeStoreError(w, err, "product")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleProductDemand answers "what do I need to load today" — for each
// product, how much the day's still-pending deliveries add up to, next to
// what is in stock. Stock on its own is a number with nothing to compare
// it against; this is the comparison, and it comes free from data the day
// already holds.
func (s *Server) handleProductDemand(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	date, ok := resolveDate(sess.Business, r)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	orders, err := s.store.ListDailyOrders(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "deliveries")
		return
	}

	needed := map[string]float64{}
	for _, o := range orders {
		if o.Status == domain.StatusPending {
			needed[o.ProductID] += o.Quantity
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"date": date, "needed": needed})
}

// ---------- drivers ----------

func (s *Server) handleListDrivers(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	users, err := s.store.ListUsers(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "drivers")
		return
	}

	drivers := []domain.User{}
	for _, u := range users {
		if u.Role.CanDrive() {
			drivers = append(drivers, u)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"drivers": drivers})
}

func (s *Server) handleCreateDriver(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Name  string `json:"name"`
		Phone string `json:"phone"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	// The owner adds the person, not a credential. There is no PIN to
	// choose, tell them, or reset — the driver proves the number itself
	// with a code the first time they sign in (see httpapi/otpauth.go),
	// which also means the owner never handles a secret belonging to
	// someone else.
	phone := domain.NormalizePhone(req.Phone)
	if strings.TrimSpace(req.Name) == "" || !domain.ValidPhone(phone) {
		writeError(w, http.StatusBadRequest, "a name and a valid phone number are both required", "missing_fields")
		return
	}

	created, err := s.store.CreateUser(r.Context(), domain.User{
		ID:         domain.NewID(),
		BusinessID: sess.Business.ID,
		Role:       domain.RoleDriver,
		Name:       strings.TrimSpace(req.Name),
		Phone:      phone,
		Active:     true,
	}, "")
	if errors.Is(err, storage.ErrConflict) {
		writeError(w, http.StatusConflict, "that phone number already has an account", "phone_taken")
		return
	}
	if err != nil {
		writeStoreError(w, err, "driver")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// handleSetDriverFinish records where this driver's round ends.
//
// This is routing input, not a preference: the last stop is chosen for
// whatever the round finishes at, so changing it reorders tomorrow's
// route. The farm is the default because most rounds go back there —
// undelivered stock has to be handed over and the empty bottles have to
// be returned, and neither happens at the driver's house.
func (s *Server) handleSetDriverFinish(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		FinishAt  string  `json:"finish_at"`
		FinishLat float64 `json:"finish_lat"`
		FinishLng float64 `json:"finish_lng"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	finishAt := domain.FinishAt(strings.ToLower(strings.TrimSpace(req.FinishAt)))
	if !domain.ValidFinishAt(finishAt) {
		writeError(w, http.StatusBadRequest, "finish_at must be farm, home or custom", "invalid_finish_at")
		return
	}
	if !validCoordinates(req.FinishLat, req.FinishLng) {
		writeError(w, http.StatusBadRequest,
			"finish_lat must be between -90 and 90 and finish_lng between -180 and 180", "invalid_location")
		return
	}
	// A custom finish with no pin is a setting that cannot be honoured,
	// and silently falling back to the farm would be a lie about what the
	// screen says. Refuse it instead.
	if domain.NormalizeFinishAt(finishAt) == domain.FinishAtCustom && req.FinishLat == 0 && req.FinishLng == 0 {
		writeError(w, http.StatusBadRequest,
			"drop a pin for where this round should finish", "missing_finish_pin")
		return
	}

	driver, err := s.store.GetUserByID(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "driver")
		return
	}
	if !driver.Role.CanDrive() {
		writeError(w, http.StatusBadRequest, "that account is not a driver", "not_a_driver")
		return
	}

	updated, err := s.store.SetUserFinish(r.Context(), sess.Business.ID, driver.ID, finishAt, req.FinishLat, req.FinishLng)
	if err != nil {
		writeStoreError(w, err, "driver")
		return
	}
	if err := s.reorderRoutesForDriver(r, sess, updated); err != nil {
		log.Printf("re-order routes after finish change for %s: %v", updated.ID, err)
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleSetDriverHome records where a driver lives.
//
// Still routing input, but only when this driver finishes at home — see
// domain.FinishAt. Kept separate from the finish setting because "where
// Ravi lives" is a fact about Ravi, while "where Ravi's round ends" is a
// decision about the round.
func (s *Server) handleSetDriverHome(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		HomeLat float64 `json:"home_lat"`
		HomeLng float64 `json:"home_lng"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !validCoordinates(req.HomeLat, req.HomeLng) {
		writeError(w, http.StatusBadRequest,
			"home_lat must be between -90 and 90 and home_lng between -180 and 180", "invalid_location")
		return
	}

	driver, err := s.store.GetUserByID(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "driver")
		return
	}
	if !driver.Role.CanDrive() {
		writeError(w, http.StatusBadRequest, "that account is not a driver", "not_a_driver")
		return
	}

	updated, err := s.store.SetUserHome(r.Context(), sess.Business.ID, driver.ID, req.HomeLat, req.HomeLng)
	if err != nil {
		writeStoreError(w, err, "driver")
		return
	}

	if err := s.reorderRoutesForDriver(r, sess, updated); err != nil {
		log.Printf("re-order routes after home change for %s: %v", updated.ID, err)
	}
	writeJSON(w, http.StatusOK, updated)
}

// reorderRoutesForDriver re-ends and re-orders today's routes for one
// driver, after something changed about where they finish.
//
// Without this the change only takes effect the next time someone
// happens to reassign them — an admin who moves a driver's finish point
// and looks at today's route would see the old order and reasonably
// conclude the setting does nothing.
func (s *Server) reorderRoutesForDriver(r *http.Request, sess session, driver domain.User) error {
	routes, err := s.store.ListRoutes(r.Context(), sess.Business.ID, sess.Business.Today())
	if err != nil {
		return err
	}
	lat, lng, ok := driver.FinishPoint(sess.Business)
	if !ok {
		lat, lng = 0, 0
	}
	for _, rt := range routes {
		if rt.DriverID == nil || *rt.DriverID != driver.ID {
			continue
		}
		rt.EndLat, rt.EndLng = lat, lng
		saved, err := s.store.UpdateRoute(r.Context(), rt)
		if err != nil {
			continue
		}
		if err := s.reorderForEnd(r, sess.Business.ID, saved); err != nil {
			log.Printf("re-order route %s: %v", saved.ID, err)
		}
	}
	return nil
}

func (s *Server) handleSetDriverActive(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Active bool `json:"active"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	// An admin deactivating themselves would lock the business out of its
	// own account, with no other admin necessarily existing to undo it.
	if r.PathValue("id") == sess.User.ID && !req.Active {
		writeError(w, http.StatusBadRequest, "you cannot deactivate your own account", "cannot_deactivate_self")
		return
	}

	updated, err := s.store.SetUserActive(r.Context(), sess.Business.ID, r.PathValue("id"), req.Active)
	if err != nil {
		writeStoreError(w, err, "driver")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// ---------- recurring orders ----------

func (s *Server) handleListRecurringOrders(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	orders, err := s.store.ListRecurringOrders(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "subscriptions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recurring_orders": orders})
}

func (s *Server) handleCreateRecurringOrder(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		CustomerID string  `json:"customer_id"`
		ProductID  string  `json:"product_id"`
		Quantity   float64 `json:"quantity"`
		Weekdays   []int   `json:"weekdays"`
		StartDate  string  `json:"start_date"`
		EndDate    string  `json:"end_date"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	if _, err := s.store.GetCustomer(r.Context(), sess.Business.ID, req.CustomerID); err != nil {
		writeStoreError(w, err, "customer")
		return
	}
	if !s.productExists(r, sess.Business.ID, req.ProductID) {
		writeError(w, http.StatusNotFound, "product was not found", "not_found")
		return
	}
	if req.Quantity <= 0 {
		writeError(w, http.StatusBadRequest, "quantity must be greater than zero", "invalid_quantity")
		return
	}

	mask := domain.MaskFromWeekdays(req.Weekdays)
	if mask == 0 {
		writeError(w, http.StatusBadRequest, "pick at least one weekday (0 = Sunday .. 6 = Saturday)", "no_weekdays")
		return
	}

	startDate := strings.TrimSpace(req.StartDate)
	if startDate == "" {
		startDate = sess.Business.Today()
	}
	if !validDate(startDate) {
		writeError(w, http.StatusBadRequest, "start_date must be YYYY-MM-DD", "invalid_date")
		return
	}
	endDate := strings.TrimSpace(req.EndDate)
	if endDate != "" && !validDate(endDate) {
		writeError(w, http.StatusBadRequest, "end_date must be YYYY-MM-DD", "invalid_date")
		return
	}
	if endDate != "" && endDate < startDate {
		writeError(w, http.StatusBadRequest, "end_date cannot be before start_date", "invalid_date_range")
		return
	}

	created, err := s.store.CreateRecurringOrder(r.Context(), domain.RecurringOrder{
		ID:          domain.NewID(),
		BusinessID:  sess.Business.ID,
		CustomerID:  req.CustomerID,
		ProductID:   req.ProductID,
		Quantity:    req.Quantity,
		WeekdayMask: mask,
		StartDate:   startDate,
		EndDate:     endDate,
		Active:      true,
	})
	if err != nil {
		writeStoreError(w, err, "subscription")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleSetRecurringActive(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Active bool `json:"active"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	updated, err := s.store.SetRecurringOrderActive(r.Context(), sess.Business.ID, r.PathValue("id"), req.Active)
	if err != nil {
		writeStoreError(w, err, "subscription")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) productExists(r *http.Request, businessID string, productID string) bool {
	products, err := s.store.ListProducts(r.Context(), businessID)
	if err != nil {
		return false
	}
	for _, p := range products {
		if p.ID == productID {
			return true
		}
	}
	return false
}

func validDate(date string) bool {
	_, err := time.Parse(domain.DateLayout, date)
	return err == nil
}

// ---------- the day ----------

type daySummary struct {
	Total     int `json:"total"`
	Pending   int `json:"pending"`
	Delivered int `json:"delivered"`
	Failed    int `json:"failed"`
	Skipped   int `json:"skipped"`
	// Unpinned counts stops that cannot be routed because the customer
	// has no location yet. Surfaced on the dashboard rather than silently
	// dropped, because "why is this customer missing from the route?" is
	// otherwise an unanswerable question for an admin.
	Unpinned int `json:"unpinned"`
	Unrouted int `json:"unrouted"`
}

type dayResponse struct {
	Date    string         `json:"date"`
	Summary daySummary     `json:"summary"`
	Stops   []domain.Stop  `json:"stops"`
	Routes  []domain.Route `json:"routes"`
}

func (s *Server) handleGetDay(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	date, ok := resolveDate(sess.Business, r)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	// Reading a day materializes it. A delivery business has deliveries
	// every day by definition — making an admin press a button to conjure
	// them was an artifact of how generation was built, not something the
	// work actually needs. Generation is idempotent (see
	// EnsureDailyOrder), so doing it on read costs one pass over the
	// subscriptions and can never disturb an override or a completed
	// delivery.
	//
	// Past dates are deliberately excluded: a day that has already gone by
	// is a record of what happened, and materializing it now would invent
	// deliveries that were never made. Whatever exists for a past date is
	// what that day actually was.
	if date >= sess.Business.Today() {
		if err := s.generateDay(w, r, sess.Business, date); err != nil {
			return // generateDay has already written the error response
		}
		if err := s.ensureDayRounds(r, sess.Business, date); err != nil {
			// A round that couldn't be prepared is not a reason to refuse
			// to show the day — the stops simply stay in "not yet on a
			// route", which is exactly where an admin would look for them.
			log.Printf("prepare rounds for business %s on %s: %v", sess.Business.ID, date, err)
		}
	}

	s.respondWithDay(w, r, date)
}

// handleGenerateDay is the explicit form of the materialization
// handleGetDay now does on its own. Kept as an endpoint because it is the
// one way to force a *past* date to generate — an admin reconstructing a
// day the business was offline for — which the automatic path
// deliberately refuses to do.
func (s *Server) handleGenerateDay(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	date, ok := resolveDate(sess.Business, r)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	if err := s.generateDay(w, r, sess.Business, date); err != nil {
		return // generateDay has already written the error response
	}
	s.respondWithDay(w, r, date)
}

// generateDay materializes one date's tasks from the standing
// subscriptions. It is safe to run repeatedly — EnsureDailyOrder leaves
// existing rows (and therefore existing overrides and completed
// deliveries) untouched — which is what lets a customer added mid-morning
// show up on the next read of the day.
//
// Writes its own error response and returns non-nil when it fails, so
// both callers can simply return.
func (s *Server) generateDay(w http.ResponseWriter, r *http.Request, business domain.Business, date string) error {
	subscriptions, err := s.store.ListRecurringOrders(r.Context(), business.ID)
	if err != nil {
		writeStoreError(w, err, "subscriptions")
		return err
	}
	customers, err := s.store.ListCustomers(r.Context(), business.ID)
	if err != nil {
		writeStoreError(w, err, "customers")
		return err
	}
	customersByID := map[string]domain.Customer{}
	for _, c := range customers {
		customersByID[c.ID] = c
	}

	// Resolved once for the whole run, not per subscription. Empty for
	// every business that hasn't opted into a bespoke rule, which is all
	// of them by default.
	enabled := extensions.Resolve(business.Config.Extensions)
	if len(enabled.Unknown) > 0 {
		log.Printf("business %s names extensions this build doesn't have: %s",
			business.ID, strings.Join(enabled.Unknown, ", "))
	}

	created := 0
	for _, sub := range subscriptions {
		customer, known := customersByID[sub.CustomerID]
		// The weekday pattern and the customer's own active flag are
		// decided by the core, always, for every business. Extensions run
		// afterwards and can only narrow this — see the ordering note on
		// everyndays.AdjustGeneratedOrder.
		if !sub.RunsOn(date) || !known || !customer.Active {
			continue
		}

		recurringID := sub.ID
		order := domain.DailyOrder{
			ID:               domain.NewID(),
			BusinessID:       business.ID,
			CustomerID:       sub.CustomerID,
			ProductID:        sub.ProductID,
			RecurringOrderID: &recurringID,
			DeliveryDate:     date,
			Quantity:         sub.Quantity,
			BaseQuantity:     sub.Quantity,
			Status:           domain.StatusPending,
		}

		if !enabled.Empty() {
			keep, err := enabled.AdjustGeneratedOrder(r.Context(), extensions.OrderContext{
				Business:     business,
				Customer:     customer,
				Subscription: sub,
				Date:         date,
			}, &order)
			if err != nil {
				// A bespoke rule that can't decide must stop the run
				// rather than produce a partial day — see
				// extensions.Set.AdjustGeneratedOrder.
				log.Printf("generate day for business %s: %v", business.ID, err)
				writeError(w, http.StatusInternalServerError, err.Error(), "extension_failed")
				return err
			}
			if !keep {
				continue
			}
		}

		_, wasCreated, err := s.store.EnsureDailyOrder(r.Context(), order)
		if err != nil {
			writeStoreError(w, err, "deliveries")
			return err
		}
		if wasCreated {
			created++
		}
	}

	if created > 0 {
		log.Printf("generated %d deliveries for business %s on %s", created, business.ID, date)
	}
	return nil
}

func (s *Server) handleCreateAdHocOrder(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		CustomerID   string             `json:"customer_id"`
		ProductID    string             `json:"product_id"`
		Quantity     float64            `json:"quantity"`
		Date         string             `json:"date"`
		Note         string             `json:"note"`
		CustomFields domain.FieldValues `json:"custom_fields"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	if _, err := s.store.GetCustomer(r.Context(), sess.Business.ID, req.CustomerID); err != nil {
		writeStoreError(w, err, "customer")
		return
	}
	if !s.productExists(r, sess.Business.ID, req.ProductID) {
		writeError(w, http.StatusNotFound, "product was not found", "not_found")
		return
	}
	if req.Quantity <= 0 {
		writeError(w, http.StatusBadRequest, "quantity must be greater than zero", "invalid_quantity")
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

	customFields, ok := s.customFieldsFor(w, sess, domain.TargetDailyOrder, req.CustomFields)
	if !ok {
		return
	}

	// BaseQuantity 0 with a non-zero Quantity is what marks this as a
	// one-off: there is no standing arrangement behind it, so the whole
	// amount is "extra" (see domain.DailyOrder.IsOverridden).
	created, err := s.store.CreateDailyOrder(r.Context(), domain.DailyOrder{
		ID:             domain.NewID(),
		BusinessID:     sess.Business.ID,
		CustomerID:     req.CustomerID,
		ProductID:      req.ProductID,
		DeliveryDate:   date,
		Quantity:       req.Quantity,
		BaseQuantity:   0,
		Status:         domain.StatusPending,
		OverrideReason: "one-off order",
		Note:           strings.TrimSpace(req.Note),
		CustomFields:   customFields,
	})
	if err != nil {
		writeStoreError(w, err, "delivery")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// handleOverrideOrder is the date-specific override — the feature that
// keeps "no milk this week" from ever touching the customer's standing
// subscription. Quantity and status are both optional; sending only a
// quantity changes the amount, sending status=skipped cancels just this
// date.
func (s *Server) handleOverrideOrder(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Quantity     *float64            `json:"quantity"`
		Status       *string             `json:"status"`
		Reason       string              `json:"reason"`
		Note         string              `json:"note"`
		CustomFields *domain.FieldValues `json:"custom_fields"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	order, err := s.store.GetDailyOrder(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "delivery")
		return
	}

	if req.Quantity != nil {
		if *req.Quantity < 0 {
			writeError(w, http.StatusBadRequest, "quantity cannot be negative", "invalid_quantity")
			return
		}
		order.Quantity = *req.Quantity
		// Zero quantity and "skip this date" are the same intent
		// expressed two ways; normalizing here means the driver's list
		// never shows a stop asking for nothing.
		if *req.Quantity == 0 && req.Status == nil {
			order.Status = domain.StatusSkipped
		}
	}

	if req.Status != nil {
		status := domain.DeliveryStatus(strings.TrimSpace(*req.Status))
		if !domain.ValidDeliveryStatus(status) {
			writeError(w, http.StatusBadRequest, "status must be pending, delivered, failed, or skipped", "invalid_status")
			return
		}
		order.Status = status
		if status == domain.StatusSkipped && req.Quantity == nil {
			order.Quantity = 0
		}
		if status == domain.StatusPending {
			order.CompletedAt = nil
		}
	}

	if strings.TrimSpace(req.Reason) != "" {
		order.OverrideReason = strings.TrimSpace(req.Reason)
	}
	if strings.TrimSpace(req.Note) != "" {
		order.Note = strings.TrimSpace(req.Note)
	}
	if req.CustomFields != nil {
		customFields, ok := s.customFieldsFor(w, sess, domain.TargetDailyOrder, *req.CustomFields)
		if !ok {
			return
		}
		order.CustomFields = customFields
	}

	updated, err := s.store.UpdateDailyOrder(r.Context(), order)
	if err != nil {
		writeStoreError(w, err, "delivery")
		return
	}

	s.recordEvent(r, sess, updated, "admin override")
	writeJSON(w, http.StatusOK, updated)
}

// ---------- routes ----------

func (s *Server) handleListRoutes(w http.ResponseWriter, r *http.Request) {
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
	writeJSON(w, http.StatusOK, map[string]any{"date": date, "routes": routes})
}

type buildRouteRequest struct {
	Date     string `json:"date"`
	Name     string `json:"name"`
	DriverID string `json:"driver_id"`
	// RouteID rebuilds an existing route in place instead of creating a
	// new one — the "I added two customers after the round was planned"
	// case. Its current stops are pooled back in with the unassigned ones
	// and the whole thing is re-ordered.
	RouteID  string   `json:"route_id"`
	StartLat float64  `json:"start_lat"`
	StartLng float64  `json:"start_lng"`
	OrderIDs []string `json:"order_ids"`
	// AllowEmpty creates the round even with nothing to put on it. That
	// is a real thing to want now that stops can be moved between rounds
	// from the map: an admin adds "Evening round", then drags the three
	// late customers onto it. Without this, creating a round is only
	// possible while unrouted work happens to exist, which is exactly
	// when you least need a new one.
	AllowEmpty bool `json:"allow_empty"`
}

func (s *Server) handleBuildRoute(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req buildRouteRequest
	if !decodeJSON(w, r, &req) {
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
	if !validCoordinates(req.StartLat, req.StartLng) {
		writeError(w, http.StatusBadRequest, "start_lat/start_lng are not a valid location", "invalid_location")
		return
	}

	var driverID *string
	if id := strings.TrimSpace(req.DriverID); id != "" {
		driver, err := s.store.GetUserByID(r.Context(), sess.Business.ID, id)
		if err != nil {
			writeStoreError(w, err, "driver")
			return
		}
		if !driver.Role.CanDrive() {
			writeError(w, http.StatusBadRequest, "that account is not a driver", "not_a_driver")
			return
		}
		driverID = &driver.ID
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

	existingRouteID := strings.TrimSpace(req.RouteID)
	candidates, skippedUnpinned := selectRoutableOrders(orders, customersByID, req.OrderIDs, existingRouteID)
	if len(candidates) == 0 && !req.AllowEmpty {
		writeError(w, http.StatusBadRequest, "there are no pinned, pending deliveries to put on a route", "no_stops")
		return
	}

	points := make([]route.Point, 0, len(candidates))
	for _, o := range candidates {
		c := customersByID[o.CustomerID]
		points = append(points, route.Point{ID: o.ID, Lat: c.Lat, Lng: c.Lng, Band: c.Priority.Rank()})
	}
	ordered, meters := route.OptimizePrioritised(route.Point{Lat: req.StartLat, Lng: req.StartLng}, points, nil)

	orderedIDs := make([]string, 0, len(ordered))
	for _, p := range ordered {
		orderedIDs = append(orderedIDs, p.ID)
	}

	built, err := s.persistRoute(r, sess, existingRouteID, date, req, driverID, meters, orderedIDs)
	if err != nil {
		writeStoreError(w, err, "route")
		return
	}

	stops, err := s.buildStops(r, sess.Business.ID, filterByRoute(orders, orderedIDs, built.ID))
	if err != nil {
		writeStoreError(w, err, "route")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"route":            built,
		"stops":            stops,
		"skipped_unpinned": skippedUnpinned,
	})
}

// ensureDayRounds makes the day's rounds exist and puts every pending,
// pinned delivery on the one that covers its part of the map.
//
// This is the other half of "a delivery business has deliveries every
// day". A dairy that runs a Miryalguda round and a Kodad round runs them
// *every* day — having to hand-build both for each date was the same
// busywork the Generate button used to be. So rounds are derived from
// the service areas the same way deliveries are derived from
// subscriptions: one round per active area that has work in it, named
// after the area, starting at its centre.
//
// Anchoring to service areas rather than to "nearest existing round" is
// load-bearing. Nearest-wins put every Kodad customer on the Miryalguda
// round on any day where the Kodad round didn't happen to exist yet —
// 60km away, but the only round there was, so it won. A stop now joins a
// round only when both sit in the *same* service area, and a stop that
// belongs to no area stays visible as unrouted for a human to place.
func (s *Server) ensureDayRounds(r *http.Request, business domain.Business, date string) error {
	areas, err := s.store.ListServiceAreas(r.Context(), business.ID)
	if err != nil {
		return err
	}
	orders, err := s.store.ListDailyOrders(r.Context(), business.ID, date)
	if err != nil {
		return err
	}
	customers, err := s.store.ListCustomers(r.Context(), business.ID)
	if err != nil {
		return err
	}
	customersByID := map[string]domain.Customer{}
	for _, c := range customers {
		customersByID[c.ID] = c
	}

	// Which area each unrouted stop belongs to. Built first so a round is
	// only ever created for an area that actually has work in it — an
	// admin who set up six localities and delivers to two today should
	// see two rounds, not six empty ones.
	needsRound := map[string]bool{}
	areaOfOrder := map[string]string{}
	pinOfOrder := map[string]route.Point{}
	for _, o := range orders {
		if o.RouteID != nil || o.Status != domain.StatusPending {
			continue
		}
		customer, known := customersByID[o.CustomerID]
		if !known || !customer.HasPin() {
			continue // unpinned stays unrouted, and is counted in the day summary
		}
		if area, ok := areaContaining(customer.Lat, customer.Lng, areas); ok {
			areaOfOrder[o.ID] = area.ID
			pinOfOrder[o.ID] = route.Point{Lat: customer.Lat, Lng: customer.Lng, Band: customer.Priority.Rank()}
			needsRound[area.ID] = true
		}
	}

	routes, err := s.store.ListRoutes(r.Context(), business.ID, date)
	if err != nil {
		return err
	}

	// Which area each existing round serves, so a round an admin built by
	// hand near an area's centre is recognised as that area's round
	// rather than being duplicated beside it.
	//
	// An area can hold more than one round — that is what splitting it
	// between drivers produces (see handleSetAreaDrivers). routeForArea
	// answers "does this area already have a round", which only needs one
	// of them; roundsInArea keeps the rest, so a stop added after the
	// split is placed among them rather than always landing on whichever
	// happened to be listed first.
	routeForArea := map[string]domain.Route{}
	roundsInArea := map[string][]domain.Route{}
	for _, rt := range routes {
		if area, ok := areaContaining(rt.StartLat, rt.StartLng, areas); ok {
			if _, taken := routeForArea[area.ID]; !taken {
				routeForArea[area.ID] = rt
			}
			roundsInArea[area.ID] = append(roundsInArea[area.ID], rt)
		}
	}

	// Yesterday's rounds, to carry the drivers forward: the same people
	// drive the same rounds day after day on a milk route, and making an
	// admin re-pick them every morning is exactly the kind of daily
	// busywork this pass is removing. Only ever used to fill an
	// assignment in, never to override one.
	//
	// All of yesterday's drivers for an area, not just one — an area split
	// between three drivers yesterday is split between the same three
	// today, or the split would have to be redone every single morning
	// and would be worth nothing.
	previousDriversFor := map[string][]string{}
	if yesterday, err := shiftDate(date, -1); err == nil {
		if priorRoutes, err := s.store.ListRoutes(r.Context(), business.ID, yesterday); err == nil {
			for _, rt := range priorRoutes {
				if rt.DriverID == nil {
					continue
				}
				area, ok := areaContaining(rt.StartLat, rt.StartLng, areas)
				if !ok {
					continue
				}
				already := false
				for _, id := range previousDriversFor[area.ID] {
					if id == *rt.DriverID {
						already = true
						break
					}
				}
				if !already {
					previousDriversFor[area.ID] = append(previousDriversFor[area.ID], *rt.DriverID)
				}
			}
		}
	}

	// A driver carried forward may have been deactivated overnight, and
	// their home is what a split round finishes at — so resolve them once
	// here rather than trusting yesterday's copy.
	driverByID := map[string]domain.User{}
	for _, ids := range previousDriversFor {
		for _, id := range ids {
			if _, done := driverByID[id]; done {
				continue
			}
			if u, err := s.store.GetUserByID(r.Context(), business.ID, id); err == nil && u.Active && u.Role.CanDrive() {
				driverByID[id] = u
			}
		}
	}
	liveDriversFor := func(areaID string) []domain.User {
		out := make([]domain.User, 0, len(previousDriversFor[areaID]))
		for _, id := range previousDriversFor[areaID] {
			if u, ok := driverByID[id]; ok {
				out = append(out, u)
			}
		}
		return out
	}

	// Stops that the split below has already spoken for, so the general
	// attach loop further down leaves them alone.
	preAssigned := map[string]string{}

	for _, area := range areas {
		if !area.Active || !needsRound[area.ID] {
			continue
		}
		if _, exists := routeForArea[area.ID]; exists {
			continue
		}

		// Yesterday this area was shared between several drivers, so today
		// is too. Cut it the same way and hand each cluster to the driver
		// who finishes nearest it, exactly as handleSetAreaDrivers would
		// have — this is that same plan, arriving on its own the next
		// morning instead of being asked for again.
		if crew := liveDriversFor(area.ID); len(crew) > 1 {
			if err := s.prepareSplitArea(r, business, date, area, crew, areaOfOrder, pinOfOrder, preAssigned,
				routeForArea, roundsInArea); err != nil {
				return err
			}
			continue
		}

		status := domain.RouteDraft
		var driverID *string
		var endLat, endLng float64
		if crew := liveDriversFor(area.ID); len(crew) == 1 {
			driverID = &crew[0].ID
			status = domain.RouteAssigned
			// A round ends wherever its driver finishes (see
			// domain.FinishAt). Carrying the driver forward has to carry
			// that with it, or yesterday's round and today's identical one
			// would be ordered differently for no reason the admin can see.
			endLat, endLng, _ = crew[0].FinishPoint(business)
		}
		created, err := s.store.CreateRoute(r.Context(), domain.Route{
			ID:         domain.NewID(),
			BusinessID: business.ID,
			RouteDate:  date,
			Name:       area.Name + " route",
			DriverID:   driverID,
			Status:     status,
			StartLat:   area.Lat,
			StartLng:   area.Lng,
			EndLat:     endLat,
			EndLng:     endLng,
		})
		if errors.Is(err, storage.ErrConflict) {
			// Someone else's read got here first — the round now exists,
			// it just isn't in the list we loaded a moment ago. Adopt
			// theirs rather than failing: both requests wanted the same
			// thing, and one of them achieving it is success for both.
			refreshed, listErr := s.store.ListRoutes(r.Context(), business.ID, date)
			if listErr != nil {
				return listErr
			}
			for _, rt := range refreshed {
				if rt.Name == area.Name+" route" {
					routeForArea[area.ID] = rt
					break
				}
			}
			if _, adopted := routeForArea[area.ID]; !adopted {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		routeForArea[area.ID] = created
		roundsInArea[area.ID] = append(roundsInArea[area.ID], created)
		log.Printf("prepared %s for business %s on %s", created.Name, business.ID, date)
	}

	// Where each round's existing work sits, so a new stop in a split
	// area can join the round already working nearest to it. Only built
	// for areas that actually hold more than one round — the ordinary
	// one-round-per-area business never pays for this.
	stopsOnRound := map[string][]route.Point{}
	for _, rounds := range roundsInArea {
		if len(rounds) < 2 {
			continue
		}
		for _, rt := range rounds {
			stopsOnRound[rt.ID] = nil
		}
	}
	if len(stopsOnRound) > 0 {
		for _, o := range orders {
			if o.RouteID == nil {
				continue
			}
			if _, tracked := stopsOnRound[*o.RouteID]; !tracked {
				continue
			}
			if c, known := customersByID[o.CustomerID]; known && c.HasPin() {
				stopsOnRound[*o.RouteID] = append(stopsOnRound[*o.RouteID], route.Point{Lat: c.Lat, Lng: c.Lng})
			}
		}
	}

	// Now attach. Only rounds that actually gained a stop get
	// re-optimized; on the common read (nothing new since last time) this
	// loop does no writes at all.
	gained := map[string]bool{}
	assignedTo := map[string]string{}
	for orderID, routeID := range preAssigned {
		assignedTo[orderID] = routeID
		gained[routeID] = true
	}
	for orderID, areaID := range areaOfOrder {
		if _, spoken := assignedTo[orderID]; spoken {
			continue
		}
		rt, ok := routeForArea[areaID]
		if !ok {
			continue
		}
		// A split area: give the stop to the round already delivering
		// closest to it, so a customer added mid-morning joins the driver
		// who is going past their door rather than whichever round sorts
		// first. Falls back to routeForArea when no round has any pinned
		// work yet to compare against.
		if rounds := roundsInArea[areaID]; len(rounds) > 1 {
			if nearest, ok := nearestRound(pinOfOrder[orderID], rounds, stopsOnRound); ok {
				rt = nearest
			}
		}
		assignedTo[orderID] = rt.ID
		gained[rt.ID] = true
	}
	if len(gained) == 0 {
		return nil
	}

	// Over every round in every area, not just one per area: a split area
	// holds several, and each of them has its own stops to order.
	for _, rounds := range roundsInArea {
		for _, rt := range rounds {
			if !gained[rt.ID] {
				continue
			}
			if err := s.orderRound(r, business.ID, rt, orders, customersByID, assignedTo); err != nil {
				return err
			}
		}
	}
	return nil
}

// orderRound works out the visiting order for one round and writes it.
// Split out of ensureDayRounds so that every round in an area gets the
// same treatment — see the loop above, which used to reach only the first
// round of each area and so left a split area's second driver with no
// stops attached at all.
func (s *Server) orderRound(
	r *http.Request,
	businessID string,
	rt domain.Route,
	orders []domain.DailyOrder,
	customersByID map[string]domain.Customer,
	assignedTo map[string]string,
) error {
	points := make([]route.Point, 0)
	for _, o := range orders {
		onThisRoute := (o.RouteID != nil && *o.RouteID == rt.ID) || assignedTo[o.ID] == rt.ID
		if !onThisRoute {
			continue
		}
		c := customersByID[o.CustomerID]
		points = append(points, route.Point{ID: o.ID, Lat: c.Lat, Lng: c.Lng, Band: c.Priority.Rank()})
	}

	// A route a human arranged by hand is left alone: new stops are
	// appended in the order they arrived rather than the whole thing
	// being re-sorted underneath the person who arranged it. See
	// handleMoveStopPosition.
	if rt.ManualOrder {
		// Keep what is already on the route in the sequence a human gave
		// it — which is the stored Sequence, not the order these points
		// happened to be built in — and append anything new to the end.
		type placed struct {
			id  string
			seq int
		}
		existing := make([]placed, 0, len(points))
		fresh := make([]string, 0, len(points))
		for _, o := range orders {
			onThisRoute := (o.RouteID != nil && *o.RouteID == rt.ID) || assignedTo[o.ID] == rt.ID
			if !onThisRoute {
				continue
			}
			if o.RouteID != nil && *o.RouteID == rt.ID {
				existing = append(existing, placed{id: o.ID, seq: o.Sequence})
			} else {
				fresh = append(fresh, o.ID)
			}
		}
		sort.SliceStable(existing, func(i, j int) bool { return existing[i].seq < existing[j].seq })

		orderedIDs := make([]string, 0, len(existing)+len(fresh))
		for _, e := range existing {
			orderedIDs = append(orderedIDs, e.id)
		}
		orderedIDs = append(orderedIDs, fresh...)
		return s.store.AssignStops(r.Context(), businessID, rt.ID, orderedIDs)
	}

	start := route.Point{Lat: rt.StartLat, Lng: rt.StartLng}
	var ordered []route.Point
	var meters float64
	if rt.HasEnd() {
		finish := route.Point{Lat: rt.EndLat, Lng: rt.EndLng}
		ordered, meters = route.OptimizePrioritised(start, points, &finish)
	} else {
		ordered, meters = route.OptimizePrioritised(start, points, nil)
	}
	orderedIDs := make([]string, 0, len(ordered))
	for _, p := range ordered {
		orderedIDs = append(orderedIDs, p.ID)
	}
	if err := s.store.AssignStops(r.Context(), businessID, rt.ID, orderedIDs); err != nil {
		return err
	}
	rt.EstimatedMeters = meters
	if _, err := s.store.UpdateRoute(r.Context(), rt); err != nil {
		return err
	}
	log.Printf("%s now has %d stops", rt.Name, len(orderedIDs))
	return nil
}

// areaContaining returns the active service area whose circle contains
// the point, nearest-centre-wins on overlap. Mirrors nearestAreaFor in
// frontend/src/serviceAreas.js exactly — the two must agree, or the
// grouping an admin sees on the Customers screen won't match the round a
// stop actually lands on.
func areaContaining(lat, lng float64, areas []domain.ServiceArea) (domain.ServiceArea, bool) {
	var best domain.ServiceArea
	bestDist := math.Inf(1)
	found := false
	for _, area := range areas {
		if !area.Active {
			continue
		}
		d := route.DistanceMeters(lat, lng, area.Lat, area.Lng)
		if d <= area.RadiusMeters && d < bestDist {
			best, bestDist, found = area, d, true
		}
	}
	return best, found
}

// nearestRound picks which of an area's rounds a loose stop should join,
// by distance to the nearest stop each round is already making.
//
// Only meaningful once an area holds several rounds — that is, once it
// has been split between drivers (see handleSetAreaDrivers). Measuring
// against a round's actual stops rather than its start point is what
// makes this work at all: every round in a split area starts from the
// same area centre, so start points cannot tell them apart.
//
// A round with no pinned work yet is skipped rather than treated as
// infinitely far, and if none of them has any, the caller keeps its own
// fallback.
func nearestRound(pin route.Point, rounds []domain.Route, stopsOnRound map[string][]route.Point) (domain.Route, bool) {
	var best domain.Route
	bestDist := math.Inf(1)
	found := false
	for _, rt := range rounds {
		for _, stop := range stopsOnRound[rt.ID] {
			d := route.DistanceMeters(pin.Lat, pin.Lng, stop.Lat, stop.Lng)
			if d < bestDist {
				best, bestDist, found = rt, d, true
			}
		}
	}
	return best, found
}

// shiftDate moves a YYYY-MM-DD string by whole days, staying on the
// calendar rather than going through an instant — same reasoning as
// domain.DateLayout being a string in the first place.
func shiftDate(date string, days int) (string, error) {
	parsed, err := time.Parse(domain.DateLayout, date)
	if err != nil {
		return "", err
	}
	return parsed.AddDate(0, 0, days).Format(domain.DateLayout), nil
}

// persistRoute creates or updates the route record and attaches the
// ordered stops. Split out of handleBuildRoute so the create-vs-rebuild
// branch is in one place rather than threaded through the optimization.
func (s *Server) persistRoute(r *http.Request, sess session, existingRouteID string, date string, req buildRouteRequest, driverID *string, meters float64, orderedIDs []string) (domain.Route, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Route " + date
	}

	status := domain.RouteDraft
	if driverID != nil {
		status = domain.RouteAssigned
	}

	var built domain.Route
	var err error
	if existingRouteID != "" {
		built, err = s.store.GetRoute(r.Context(), sess.Business.ID, existingRouteID)
		if err != nil {
			return domain.Route{}, err
		}
		built.Name = name
		built.StartLat = req.StartLat
		built.StartLng = req.StartLng
		built.EstimatedMeters = meters
		if driverID != nil {
			built.DriverID = driverID
			// A route already under way keeps its in-progress status —
			// re-planning the remaining stops shouldn't reset a round the
			// driver has already started.
			if built.Status == domain.RouteDraft {
				built.Status = domain.RouteAssigned
			}
		}
		built, err = s.store.UpdateRoute(r.Context(), built)
	} else {
		built, err = s.store.CreateRoute(r.Context(), domain.Route{
			ID:              domain.NewID(),
			BusinessID:      sess.Business.ID,
			RouteDate:       date,
			Name:            name,
			DriverID:        driverID,
			Status:          status,
			StartLat:        req.StartLat,
			StartLng:        req.StartLng,
			EstimatedMeters: meters,
		})
	}
	if err != nil {
		return domain.Route{}, err
	}

	if err := s.store.AssignStops(r.Context(), sess.Business.ID, built.ID, orderedIDs); err != nil {
		return domain.Route{}, err
	}
	return built, nil
}

// selectRoutableOrders decides which of the day's deliveries belong on
// the route being built, and reports how many were left off for want of a
// pin. Explicit order_ids win; otherwise it takes every pending stop that
// isn't already committed to a *different* route.
func selectRoutableOrders(orders []domain.DailyOrder, customersByID map[string]domain.Customer, explicitIDs []string, rebuildingRouteID string) ([]domain.DailyOrder, int) {
	wanted := map[string]bool{}
	for _, id := range explicitIDs {
		wanted[id] = true
	}

	candidates := []domain.DailyOrder{}
	skippedUnpinned := 0

	for _, o := range orders {
		if len(wanted) > 0 && !wanted[o.ID] {
			continue
		}
		if len(wanted) == 0 {
			if !o.Open() {
				continue
			}
			alreadyElsewhere := o.RouteID != nil && *o.RouteID != rebuildingRouteID
			if alreadyElsewhere {
				continue
			}
		}

		customer, ok := customersByID[o.CustomerID]
		if !ok || !customer.HasPin() {
			skippedUnpinned++
			continue
		}
		candidates = append(candidates, o)
	}
	return candidates, skippedUnpinned
}

// filterByRoute returns the given orders in the freshly-computed stop
// order, with route and sequence applied — so the response reflects the
// assignment that was just written without a second round-trip.
func filterByRoute(orders []domain.DailyOrder, orderedIDs []string, routeID string) []domain.DailyOrder {
	byID := map[string]domain.DailyOrder{}
	for _, o := range orders {
		byID[o.ID] = o
	}

	out := make([]domain.DailyOrder, 0, len(orderedIDs))
	for i, id := range orderedIDs {
		o, ok := byID[id]
		if !ok {
			continue
		}
		assigned := routeID
		o.RouteID = &assigned
		o.Sequence = i + 1
		out = append(out, o)
	}
	return out
}

func (s *Server) handleAssignRoute(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		DriverID string `json:"driver_id"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	target, err := s.store.GetRoute(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "route")
		return
	}

	if id := strings.TrimSpace(req.DriverID); id != "" {
		driver, err := s.store.GetUserByID(r.Context(), sess.Business.ID, id)
		if err != nil {
			writeStoreError(w, err, "driver")
			return
		}
		if !driver.Role.CanDrive() {
			writeError(w, http.StatusBadRequest, "that account is not a driver", "not_a_driver")
			return
		}
		if !driver.Active {
			writeError(w, http.StatusBadRequest, "that driver account is deactivated", "driver_inactive")
			return
		}
		target.DriverID = &driver.ID
		if target.Status == domain.RouteDraft {
			target.Status = domain.RouteAssigned
		}
		// Where the round ends depends on who is driving it, so it is
		// resolved here rather than at planning time — which matches the
		// order an admin actually works in: plan the day, then hand
		// rounds out. Most drivers finish back at the farm, because
		// undelivered stock and empty bottles have to be handed over
		// somewhere that isn't their kitchen; see domain.FinishAt.
		if lat, lng, ok := driver.FinishPoint(sess.Business); ok {
			target.EndLat, target.EndLng = lat, lng
		} else {
			target.EndLat, target.EndLng = 0, 0
		}
	} else {
		// An empty driver_id unassigns — the route goes back to being a
		// draft the admin can hand to someone else, and stops finishing
		// anywhere in particular.
		target.DriverID = nil
		target.Status = domain.RouteDraft
		target.EndLat, target.EndLng = 0, 0
	}

	updated, err := s.store.UpdateRoute(r.Context(), target)
	if err != nil {
		writeStoreError(w, err, "route")
		return
	}

	// Re-order for the new finish. Skipped when nothing about the ending
	// changed, so handing a round to a driver with no home saved is the
	// same cheap operation it always was.
	if err := s.reorderForEnd(r, sess.Business.ID, updated); err != nil {
		// The assignment itself succeeded; a failure to re-order leaves a
		// drivable round in the old sequence rather than no round at all.
		log.Printf("re-order route %s after assignment: %v", updated.ID, err)
	}

	refreshed, err := s.store.GetRoute(r.Context(), sess.Business.ID, updated.ID)
	if err != nil {
		writeJSON(w, http.StatusOK, updated)
		return
	}
	writeJSON(w, http.StatusOK, refreshed)
}

// reorderForEnd re-optimizes a route now that where it finishes may have
// changed. See route.OptimizeReturning for why an end point changes the
// best order rather than just the total.
func (s *Server) reorderForEnd(r *http.Request, businessID string, rt domain.Route) error {
	orders, err := s.store.ListDailyOrders(r.Context(), businessID, rt.RouteDate)
	if err != nil {
		return err
	}
	customers, err := s.store.ListCustomers(r.Context(), businessID)
	if err != nil {
		return err
	}
	customersByID := map[string]domain.Customer{}
	for _, c := range customers {
		customersByID[c.ID] = c
	}

	members := []string{}
	for _, o := range orders {
		if o.RouteID != nil && *o.RouteID == rt.ID && o.Status == domain.StatusPending {
			members = append(members, o.ID)
		}
	}
	if len(members) == 0 {
		return nil
	}
	return s.reorderRoute(r, businessID, rt, members, orders, customersByID)
}

// ---------- shared read models ----------

// buildStops joins daily orders with the customer and product details a
// human needs to act on them. It loads the business's customers and
// products once into maps rather than querying per order: tenants here
// are small businesses (tens to low hundreds of customers), so two list
// queries beat N+1 lookups by a wide margin and keep the driver's single
// most important request to a fixed number of round-trips.
func (s *Server) buildStops(r *http.Request, businessID string, orders []domain.DailyOrder) ([]domain.Stop, error) {
	customers, err := s.store.ListCustomers(r.Context(), businessID)
	if err != nil {
		return nil, err
	}
	products, err := s.store.ListProducts(r.Context(), businessID)
	if err != nil {
		return nil, err
	}

	customersByID := map[string]domain.Customer{}
	for _, c := range customers {
		customersByID[c.ID] = c
	}
	productsByID := map[string]domain.Product{}
	for _, p := range products {
		productsByID[p.ID] = p
	}

	stops := make([]domain.Stop, 0, len(orders))
	for _, o := range orders {
		c := customersByID[o.CustomerID]
		p := productsByID[o.ProductID]
		stops = append(stops, domain.Stop{
			DailyOrder:      o,
			CustomerName:    c.Name,
			CustomerPhone:   c.Phone,
			CustomerAddress: c.Address,
			CustomerNotes:   c.Notes,
			Lat:             c.Lat,
			Lng:             c.Lng,
			ProductName:     p.Name,
			ProductUnit:     p.Unit,
			CustomerFields:  c.CustomFields,
		})
	}
	return stops, nil
}

func (s *Server) respondWithDay(w http.ResponseWriter, r *http.Request, date string) {
	sess := sessionFrom(r.Context())

	orders, err := s.store.ListDailyOrders(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "deliveries")
		return
	}
	stops, err := s.buildStops(r, sess.Business.ID, orders)
	if err != nil {
		writeStoreError(w, err, "deliveries")
		return
	}
	routes, err := s.store.ListRoutes(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "routes")
		return
	}

	summary := daySummary{Total: len(stops)}
	for _, stop := range stops {
		switch stop.Status {
		case domain.StatusPending:
			summary.Pending++
		case domain.StatusDelivered:
			summary.Delivered++
		case domain.StatusFailed:
			summary.Failed++
		case domain.StatusSkipped:
			summary.Skipped++
		}
		if stop.Lat == 0 && stop.Lng == 0 {
			summary.Unpinned++
		}
		if stop.RouteID == nil && stop.Status == domain.StatusPending {
			summary.Unrouted++
		}
	}

	writeJSON(w, http.StatusOK, dayResponse{Date: date, Summary: summary, Stops: stops, Routes: routes})
}

// recordEvent appends to the audit trail. A failure to write the trail is
// logged but never fails the request: the delivery status change itself
// has already been committed, and refusing it after the fact would be
// worse than an incomplete history.
func (s *Server) recordEvent(r *http.Request, sess session, order domain.DailyOrder, note string) {
	if err := s.store.AppendDeliveryEvent(r.Context(), domain.DeliveryEvent{
		ID:           domain.NewID(),
		BusinessID:   sess.Business.ID,
		DailyOrderID: order.ID,
		ActorUserID:  sess.User.ID,
		Status:       order.Status,
		Note:         note,
	}); err != nil {
		log.Printf("record delivery event for %s: %v", order.ID, err)
	}
}
