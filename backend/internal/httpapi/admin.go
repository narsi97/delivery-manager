package httpapi

import (
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"delivery-manager/internal/auth"
	"delivery-manager/internal/domain"
	"delivery-manager/internal/extensions"
	"delivery-manager/internal/route"
	"delivery-manager/internal/storage"
)

// ---------- customers ----------

type customerRequest struct {
	Name    string  `json:"name"`
	Phone   string  `json:"phone"`
	Address string  `json:"address"`
	Lat     float64 `json:"lat"`
	Lng     float64 `json:"lng"`
	Notes   string  `json:"notes"`
	Active  *bool   `json:"active"`
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

	customer := domain.Customer{
		ID:           domain.NewID(),
		BusinessID:   sess.Business.ID,
		Name:         strings.TrimSpace(req.Name),
		Phone:        strings.TrimSpace(req.Phone),
		Address:      strings.TrimSpace(req.Address),
		Lat:          req.Lat,
		Lng:          req.Lng,
		Notes:        strings.TrimSpace(req.Notes),
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
		PIN   string `json:"pin"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	phone := domain.NormalizePhone(req.Phone)
	if strings.TrimSpace(req.Name) == "" || phone == "" {
		writeError(w, http.StatusBadRequest, "name and phone are both required", "missing_fields")
		return
	}

	pinHash, err := auth.HashPIN(req.PIN)
	if err != nil {
		writePINError(w, err)
		return
	}

	created, err := s.store.CreateUser(r.Context(), domain.User{
		ID:         domain.NewID(),
		BusinessID: sess.Business.ID,
		Role:       domain.RoleDriver,
		Name:       strings.TrimSpace(req.Name),
		Phone:      phone,
		Active:     true,
	}, pinHash)
	if errors.Is(err, storage.ErrConflict) {
		writeError(w, http.StatusConflict, "that phone number is already registered to a driver", "phone_taken")
		return
	}
	if err != nil {
		writeStoreError(w, err, "driver")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleResetDriverPIN(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		PIN string `json:"pin"`
	}
	if !decodeJSON(w, r, &req) {
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

	pinHash, err := auth.HashPIN(req.PIN)
	if err != nil {
		writePINError(w, err)
		return
	}
	if err := s.store.SetUserPIN(r.Context(), sess.Business.ID, driver.ID, pinHash); err != nil {
		writeStoreError(w, err, "driver")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
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

func writePINError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrWeakPIN):
		writeError(w, http.StatusBadRequest, "choose a less guessable PIN — not all the same digit or a run like 123456", "weak_pin")
	case errors.Is(err, auth.ErrPINFormat):
		writeError(w, http.StatusBadRequest, "pin must be exactly 6 digits", "invalid_pin")
	default:
		log.Printf("hash pin: %v", err)
		writeError(w, http.StatusInternalServerError, "could not set the PIN", "")
	}
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
	s.respondWithDay(w, r, date)
}

// handleGenerateDay materializes the day's tasks from the standing
// subscriptions. It is safe to run repeatedly — EnsureDailyOrder leaves
// existing rows (and therefore existing overrides and completed
// deliveries) untouched — which is what lets an admin add a customer
// mid-morning and press Generate again.
func (s *Server) handleGenerateDay(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	date, ok := resolveDate(sess.Business, r)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	subscriptions, err := s.store.ListRecurringOrders(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "subscriptions")
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

	// Resolved once for the whole run, not per subscription. Empty for
	// every business that hasn't opted into a bespoke rule, which is all
	// of them by default.
	enabled := extensions.Resolve(sess.Business.Config.Extensions)
	if len(enabled.Unknown) > 0 {
		log.Printf("business %s names extensions this build doesn't have: %s",
			sess.Business.ID, strings.Join(enabled.Unknown, ", "))
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
			BusinessID:       sess.Business.ID,
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
				Business:     sess.Business,
				Customer:     customer,
				Subscription: sub,
				Date:         date,
			}, &order)
			if err != nil {
				// A bespoke rule that can't decide must stop the run
				// rather than produce a partial day — see
				// extensions.Set.AdjustGeneratedOrder.
				log.Printf("generate day for business %s: %v", sess.Business.ID, err)
				writeError(w, http.StatusInternalServerError, err.Error(), "extension_failed")
				return
			}
			if !keep {
				continue
			}
		}

		_, wasCreated, err := s.store.EnsureDailyOrder(r.Context(), order)
		if err != nil {
			writeStoreError(w, err, "deliveries")
			return
		}
		if wasCreated {
			created++
		}
	}

	log.Printf("generated %d deliveries for business %s on %s", created, sess.Business.ID, date)
	s.respondWithDay(w, r, date)
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
	if len(candidates) == 0 {
		writeError(w, http.StatusBadRequest, "there are no pinned, pending deliveries to put on a route", "no_stops")
		return
	}

	points := make([]route.Point, 0, len(candidates))
	for _, o := range candidates {
		c := customersByID[o.CustomerID]
		points = append(points, route.Point{ID: o.ID, Lat: c.Lat, Lng: c.Lng})
	}
	ordered, meters := route.Optimize(route.Point{Lat: req.StartLat, Lng: req.StartLng}, points)

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
	} else {
		// An empty driver_id unassigns — the route goes back to being a
		// draft the admin can hand to someone else.
		target.DriverID = nil
		target.Status = domain.RouteDraft
	}

	updated, err := s.store.UpdateRoute(r.Context(), target)
	if err != nil {
		writeStoreError(w, err, "route")
		return
	}
	writeJSON(w, http.StatusOK, updated)
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
