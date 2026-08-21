package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"delivery-manager/internal/auth"
	"delivery-manager/internal/config"
	"delivery-manager/internal/domain"
	"delivery-manager/internal/storage"
)

// newTestServer wires the real server against the in-memory store. The
// tests below drive it over HTTP rather than calling handlers directly,
// so routing, middleware, role checks and JSON shapes are all covered by
// the same pass.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	cfg := config.Config{
		Environment: config.EnvironmentLocal,
		JWTSecret:   "test-secret",
		TokenTTL:    time.Hour,
		// UTC keeps "today" deterministic regardless of where the test
		// runs; the timezone behaviour itself is covered separately.
		DefaultTimezone: "UTC",
	}
	return NewServer(storage.NewMemoryStore(), auth.NewService(cfg.JWTSecret, cfg.TokenTTL), cfg)
}

type client struct {
	t      *testing.T
	server *Server
	token  string
}

func (c *client) do(method, path string, body any) (*httptest.ResponseRecorder, map[string]any) {
	c.t.Helper()

	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			c.t.Fatalf("marshal request: %v", err)
		}
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}

	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	rec := httptest.NewRecorder()
	c.server.ServeHTTP(rec, req)

	decoded := map[string]any{}
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
			// Not every response is a JSON object (some are arrays or
			// empty); leave decoded empty and let the caller assert on
			// the status instead of failing here.
			decoded = map[string]any{}
		}
	}
	return rec, decoded
}

func (c *client) mustDo(method, path string, body any, wantStatus int) map[string]any {
	c.t.Helper()
	rec, decoded := c.do(method, path, body)
	if rec.Code != wantStatus {
		c.t.Fatalf("%s %s = %d, want %d (body: %s)", method, path, rec.Code, wantStatus, rec.Body.String())
	}
	return decoded
}

func adminClient(t *testing.T, s *Server) *client {
	t.Helper()
	c := &client{t: t, server: s}
	resp := c.mustDo(http.MethodPost, "/api/v1/auth/dev-login", map[string]any{}, http.StatusOK)
	token, _ := resp["token"].(string)
	if token == "" {
		t.Fatal("dev-login returned no token")
	}
	c.token = token
	return c
}

func str(m map[string]any, key string) string {
	v, _ := m[key].(string)
	return v
}

func num(m map[string]any, key string) float64 {
	v, _ := m[key].(float64)
	return v
}

func firstProductID(t *testing.T, admin *client) string {
	t.Helper()
	resp := admin.mustDo(http.MethodGet, "/api/v1/products", nil, http.StatusOK)
	products, _ := resp["products"].([]any)
	if len(products) == 0 {
		t.Fatal("a new dairy business was seeded with no starter products")
	}
	first, _ := products[0].(map[string]any)
	return str(first, "id")
}

func createCustomer(t *testing.T, admin *client, name string, lat, lng float64) string {
	t.Helper()
	resp := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name":    name,
		"phone":   "+919000000000",
		"address": name + " address",
		"lat":     lat,
		"lng":     lng,
	}, http.StatusCreated)
	return str(resp, "id")
}

// everyWeekday makes a subscription run whatever day the test happens to
// execute on, so the suite doesn't pass on Tuesday and fail on Sunday.
var everyWeekday = []int{0, 1, 2, 3, 4, 5, 6}

func createSubscription(t *testing.T, admin *client, customerID, productID string, quantity float64) string {
	t.Helper()
	resp := admin.mustDo(http.MethodPost, "/api/v1/recurring-orders", map[string]any{
		"customer_id": customerID,
		"product_id":  productID,
		"quantity":    quantity,
		"weekdays":    everyWeekday,
	}, http.StatusCreated)
	return str(resp, "id")
}

func stopsOf(t *testing.T, resp map[string]any) []map[string]any {
	t.Helper()
	raw, _ := resp["stops"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		stop, _ := item.(map[string]any)
		out = append(out, stop)
	}
	return out
}

// TestFullDeliveryDay walks the entire product in one pass: an admin sets
// up a dairy, generates the day from subscriptions, overrides one
// customer, builds and assigns an optimized route, and a driver signs in
// with a PIN and completes the round.
func TestFullDeliveryDay(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	productID := firstProductID(t, admin)

	// Three customers laid out along a line, deliberately created in an
	// order that is not the sensible driving order.
	far := createCustomer(t, admin, "Far House", 12.9900, 77.5946)
	near := createCustomer(t, admin, "Near House", 12.9750, 77.5946)
	middle := createCustomer(t, admin, "Middle House", 12.9800, 77.5946)

	createSubscription(t, admin, far, productID, 2)
	createSubscription(t, admin, near, productID, 1)
	createSubscription(t, admin, middle, productID, 3)

	driver := admin.mustDo(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name":  "Ravi",
		"phone": "+91 98765 43210",
		"pin":   "481920",
	}, http.StatusCreated)
	driverID := str(driver, "id")

	day := admin.mustDo(http.MethodPost, "/api/v1/day/generate", nil, http.StatusOK)
	summary, _ := day["summary"].(map[string]any)
	if got := num(summary, "total"); got != 3 {
		t.Fatalf("generated %v deliveries, want 3", got)
	}
	if got := num(summary, "pending"); got != 3 {
		t.Fatalf("%v pending after generation, want 3", got)
	}

	// The middle customer is away this week: override just this date.
	var middleOrderID string
	for _, stop := range stopsOf(t, day) {
		if str(stop, "customer_id") == middle {
			middleOrderID = str(stop, "id")
		}
	}
	if middleOrderID == "" {
		t.Fatal("no delivery was generated for the middle customer")
	}

	overridden := admin.mustDo(http.MethodPatch, "/api/v1/orders/"+middleOrderID, map[string]any{
		"quantity": 0,
		"reason":   "away this week",
	}, http.StatusOK)
	if got := str(overridden, "status"); got != string(domain.StatusSkipped) {
		t.Fatalf("order status after a zero-quantity override = %q, want %q", got, domain.StatusSkipped)
	}

	// The subscription itself must be untouched — that separation is the
	// whole point of overrides.
	subs := admin.mustDo(http.MethodGet, "/api/v1/recurring-orders", nil, http.StatusOK)
	for _, raw := range subs["recurring_orders"].([]any) {
		sub, _ := raw.(map[string]any)
		if str(sub, "customer_id") == middle && num(sub, "quantity") != 3 {
			t.Fatalf("override changed the standing subscription quantity to %v, want 3", num(sub, "quantity"))
		}
	}

	// Build a route from the depot, which sits south of all three houses.
	built := admin.mustDo(http.MethodPost, "/api/v1/routes", map[string]any{
		"start_lat": 12.9700,
		"start_lng": 77.5946,
		"driver_id": driverID,
		"name":      "Morning round",
	}, http.StatusOK)

	routeStops := stopsOf(t, built)
	if len(routeStops) != 2 {
		t.Fatalf("route has %d stops, want 2 (the skipped customer must not be routed)", len(routeStops))
	}
	if got := str(routeStops[0], "customer_name"); got != "Near House" {
		t.Fatalf("first stop is %q, want the nearest house", got)
	}
	if got := str(routeStops[1], "customer_name"); got != "Far House" {
		t.Fatalf("second stop is %q, want the far house", got)
	}

	routeInfo, _ := built["route"].(map[string]any)
	if num(routeInfo, "estimated_meters") <= 0 {
		t.Fatal("route was built with no estimated distance")
	}
	if got := str(routeInfo, "status"); got != string(domain.RouteAssigned) {
		t.Fatalf("route status = %q, want %q once a driver is set", got, domain.RouteAssigned)
	}

	// The driver signs in with the phone and PIN the admin issued, typed
	// without the spaces the admin used.
	driverSession := &client{t: t, server: server}
	login := driverSession.mustDo(http.MethodPost, "/api/v1/auth/driver-login", map[string]any{
		"phone": "9876543210",
		"pin":   "481920",
	}, http.StatusOK)
	driverSession.token = str(login, "token")
	if driverSession.token == "" {
		t.Fatal("driver login returned no token")
	}

	today := driverSession.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)
	if got := num(today, "remaining"); got != 2 {
		t.Fatalf("driver sees %v remaining stops, want 2", got)
	}

	driverStops := stopsOf(t, today)
	if len(driverStops) != 2 {
		t.Fatalf("driver sees %d stops, want 2", len(driverStops))
	}
	if str(driverStops[0], "customer_name") != "Near House" {
		t.Fatalf("driver's first stop is %q, want the nearest house", str(driverStops[0], "customer_name"))
	}
	// The driver needs the doorstep details in this one payload.
	if str(driverStops[0], "customer_address") == "" || num(driverStops[0], "lat") == 0 {
		t.Fatal("driver stop is missing the address/pin needed to navigate")
	}
	if str(driverStops[0], "product_name") == "" {
		t.Fatal("driver stop is missing the product to hand over")
	}

	// Complete the round.
	driverSession.mustDo(http.MethodPost, "/api/v1/driver/stops/"+str(driverStops[0], "id")+"/status",
		map[string]any{"status": "delivered"}, http.StatusOK)
	driverSession.mustDo(http.MethodPost, "/api/v1/driver/stops/"+str(driverStops[1], "id")+"/status",
		map[string]any{"status": "failed", "note": "nobody home"}, http.StatusOK)

	after := driverSession.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)
	if got := num(after, "remaining"); got != 0 {
		t.Fatalf("%v stops still open after completing the round, want 0", got)
	}
	afterRoute, _ := after["route"].(map[string]any)
	if got := str(afterRoute, "status"); got != string(domain.RouteCompleted) {
		t.Fatalf("route status after the last stop = %q, want %q", got, domain.RouteCompleted)
	}

	final := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	finalSummary, _ := final["summary"].(map[string]any)
	if num(finalSummary, "delivered") != 1 || num(finalSummary, "failed") != 1 || num(finalSummary, "skipped") != 1 {
		t.Fatalf("final summary = %+v, want 1 delivered, 1 failed, 1 skipped", finalSummary)
	}
}

// Regenerating the day is something an admin does repeatedly during a
// morning. It must never resurrect a skipped delivery or undo a
// completed one — the most damaging bug this feature could have.
func TestRegeneratingTheDayPreservesOverridesAndProgress(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	skipped := createCustomer(t, admin, "Away Customer", 12.98, 77.59)
	kept := createCustomer(t, admin, "Regular Customer", 12.99, 77.59)
	createSubscription(t, admin, skipped, productID, 2)
	createSubscription(t, admin, kept, productID, 2)

	day := admin.mustDo(http.MethodPost, "/api/v1/day/generate", nil, http.StatusOK)

	var skippedOrderID string
	for _, stop := range stopsOf(t, day) {
		if str(stop, "customer_id") == skipped {
			skippedOrderID = str(stop, "id")
		}
	}
	admin.mustDo(http.MethodPatch, "/api/v1/orders/"+skippedOrderID, map[string]any{
		"status": "skipped",
		"reason": "on vacation",
	}, http.StatusOK)

	regenerated := admin.mustDo(http.MethodPost, "/api/v1/day/generate", nil, http.StatusOK)

	summary, _ := regenerated["summary"].(map[string]any)
	if got := num(summary, "total"); got != 2 {
		t.Fatalf("regeneration produced %v deliveries, want 2 — duplicates were created", got)
	}
	if got := num(summary, "skipped"); got != 1 {
		t.Fatalf("%v skipped after regeneration, want 1 — the override was wiped", got)
	}

	for _, stop := range stopsOf(t, regenerated) {
		if str(stop, "id") == skippedOrderID {
			if str(stop, "status") != string(domain.StatusSkipped) {
				t.Fatalf("the overridden delivery came back as %q, want skipped", str(stop, "status"))
			}
			if str(stop, "override_reason") != "on vacation" {
				t.Fatal("regeneration lost the override reason")
			}
		}
	}
}

// Customers with no pin can't be routed, but they must not vanish
// silently — an admin needs to be told why someone is missing.
func TestUnpinnedCustomersAreReportedNotSilentlyDropped(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	pinned := createCustomer(t, admin, "Pinned", 12.98, 77.59)
	unpinned := createCustomer(t, admin, "No Pin Yet", 0, 0)
	createSubscription(t, admin, pinned, productID, 1)
	createSubscription(t, admin, unpinned, productID, 1)

	day := admin.mustDo(http.MethodPost, "/api/v1/day/generate", nil, http.StatusOK)
	summary, _ := day["summary"].(map[string]any)
	if got := num(summary, "unpinned"); got != 1 {
		t.Fatalf("summary reports %v unpinned stops, want 1", got)
	}

	built := admin.mustDo(http.MethodPost, "/api/v1/routes", map[string]any{
		"start_lat": 12.97, "start_lng": 77.59,
	}, http.StatusOK)
	if got := num(built, "skipped_unpinned"); got != 1 {
		t.Fatalf("route build reports %v skipped unpinned stops, want 1", got)
	}
	if got := len(stopsOf(t, built)); got != 1 {
		t.Fatalf("route has %d stops, want 1", got)
	}
}

// Tenant isolation is the load-bearing promise of a multi-tenant SaaS:
// one dairy must never see another's customers.
func TestBusinessesCannotSeeEachOthersData(t *testing.T) {
	server := newTestServer(t)
	first := adminClient(t, server)
	createCustomer(t, first, "First Business Customer", 12.98, 77.59)

	anonymous := &client{t: t, server: server}
	rec, _ := anonymous.do(http.MethodGet, "/api/v1/customers", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated customer list = %d, want 401", rec.Code)
	}

	// A driver of the *same* business still can't reach admin endpoints.
	first.mustDo(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": "Ravi", "phone": "+919876543210", "pin": "481920",
	}, http.StatusCreated)

	driverSession := &client{t: t, server: server}
	login := driverSession.mustDo(http.MethodPost, "/api/v1/auth/driver-login", map[string]any{
		"phone": "+919876543210", "pin": "481920",
	}, http.StatusOK)
	driverSession.token = str(login, "token")

	rec, _ = driverSession.do(http.MethodGet, "/api/v1/customers", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("driver reading the customer list = %d, want 403", rec.Code)
	}
	rec, _ = driverSession.do(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": "Someone", "phone": "+919000000001", "pin": "481921",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("driver creating a driver = %d, want 403", rec.Code)
	}
}

// A driver must not be able to close a stop that belongs to someone
// else's round.
func TestDriverCannotCompleteAnotherDriversStop(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	customer := createCustomer(t, admin, "Customer", 12.98, 77.59)
	createSubscription(t, admin, customer, productID, 1)

	working := admin.mustDo(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": "Working", "phone": "+919000000011", "pin": "481920",
	}, http.StatusCreated)
	admin.mustDo(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": "Idle", "phone": "+919000000022", "pin": "481921",
	}, http.StatusCreated)

	admin.mustDo(http.MethodPost, "/api/v1/day/generate", nil, http.StatusOK)
	built := admin.mustDo(http.MethodPost, "/api/v1/routes", map[string]any{
		"start_lat": 12.97, "start_lng": 77.59, "driver_id": str(working, "id"),
	}, http.StatusOK)
	stopID := str(stopsOf(t, built)[0], "id")

	idle := &client{t: t, server: server}
	login := idle.mustDo(http.MethodPost, "/api/v1/auth/driver-login", map[string]any{
		"phone": "+919000000022", "pin": "481921",
	}, http.StatusOK)
	idle.token = str(login, "token")

	rec, _ := idle.do(http.MethodPost, "/api/v1/driver/stops/"+stopID+"/status", map[string]any{"status": "delivered"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("idle driver completing another driver's stop = %d, want 403", rec.Code)
	}
}

// Deactivating a driver has to take effect on their *existing* session,
// not just block future logins — that is the whole answer to a lost
// handset.
func TestDeactivatingADriverInvalidatesTheirSession(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	driver := admin.mustDo(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": "Ravi", "phone": "+919876543210", "pin": "481920",
	}, http.StatusCreated)

	driverSession := &client{t: t, server: server}
	login := driverSession.mustDo(http.MethodPost, "/api/v1/auth/driver-login", map[string]any{
		"phone": "+919876543210", "pin": "481920",
	}, http.StatusOK)
	driverSession.token = str(login, "token")
	driverSession.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)

	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+str(driver, "id")+"/active",
		map[string]any{"active": false}, http.StatusOK)

	rec, _ := driverSession.do(http.MethodGet, "/api/v1/driver/today", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("deactivated driver's existing session = %d, want 403", rec.Code)
	}

	rec, _ = driverSession.do(http.MethodPost, "/api/v1/auth/driver-login", map[string]any{
		"phone": "+919876543210", "pin": "481920",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("deactivated driver signing in again = %d, want 403", rec.Code)
	}
}

// PIN guessing must be bounded, since the search space is only a million
// wide.
func TestDriverLoginIsRateLimited(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	admin.mustDo(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": "Ravi", "phone": "+919876543210", "pin": "481920",
	}, http.StatusCreated)

	guesser := &client{t: t, server: server}
	for i := 0; i < driverLoginLimit; i++ {
		rec, _ := guesser.do(http.MethodPost, "/api/v1/auth/driver-login", map[string]any{
			"phone": "+919876543210", "pin": fmt.Sprintf("%06d", 100000+i),
		})
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("guess %d = %d, want 401", i, rec.Code)
		}
	}

	rec, _ := guesser.do(http.MethodPost, "/api/v1/auth/driver-login", map[string]any{
		"phone": "+919876543210", "pin": "481920",
	})
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("attempt past the limit = %d, want 429", rec.Code)
	}
}

// An admin locking themselves out of their own business, with no other
// admin to undo it, is unrecoverable without database access.
func TestAdminCannotDeactivateThemselves(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	me := admin.mustDo(http.MethodGet, "/api/v1/auth/me", nil, http.StatusOK)
	user, _ := me["user"].(map[string]any)

	rec, _ := admin.do(http.MethodPost, "/api/v1/drivers/"+str(user, "id")+"/active", map[string]any{"active": false})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("admin deactivating themselves = %d, want 400", rec.Code)
	}
}

// Rebuilding a route in place is the "I added a customer after planning"
// case: the existing stops stay on the same route and the new one joins
// them, re-ordered.
func TestRebuildingARouteAbsorbsNewStops(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	first := createCustomer(t, admin, "First", 12.9800, 77.59)
	createSubscription(t, admin, first, productID, 1)
	admin.mustDo(http.MethodPost, "/api/v1/day/generate", nil, http.StatusOK)

	built := admin.mustDo(http.MethodPost, "/api/v1/routes", map[string]any{
		"start_lat": 12.97, "start_lng": 77.59,
	}, http.StatusOK)
	routeInfo, _ := built["route"].(map[string]any)
	routeID := str(routeInfo, "id")

	// A late customer, closer to the depot than the first.
	late := createCustomer(t, admin, "Late", 12.9750, 77.59)
	createSubscription(t, admin, late, productID, 1)
	admin.mustDo(http.MethodPost, "/api/v1/day/generate", nil, http.StatusOK)

	rebuilt := admin.mustDo(http.MethodPost, "/api/v1/routes", map[string]any{
		"start_lat": 12.97, "start_lng": 77.59, "route_id": routeID,
	}, http.StatusOK)

	rebuiltRoute, _ := rebuilt["route"].(map[string]any)
	if str(rebuiltRoute, "id") != routeID {
		t.Fatal("rebuilding created a new route instead of updating the existing one")
	}
	stops := stopsOf(t, rebuilt)
	if len(stops) != 2 {
		t.Fatalf("rebuilt route has %d stops, want 2", len(stops))
	}
	if str(stops[0], "customer_name") != "Late" {
		t.Fatalf("rebuilt route starts at %q, want the closer late customer", str(stops[0], "customer_name"))
	}

	routes := admin.mustDo(http.MethodGet, "/api/v1/routes", nil, http.StatusOK)
	if got := len(routes["routes"].([]any)); got != 1 {
		t.Fatalf("%d routes exist after a rebuild, want 1", got)
	}
}

// A pin dropped at the door must not blank out the address the admin
// typed earlier — PATCH is a partial update.
func TestPatchingOnlyThePinKeepsTheRestOfTheCustomer(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	id := createCustomer(t, admin, "Anita", 0, 0)
	updated := admin.mustDo(http.MethodPatch, "/api/v1/customers/"+id, map[string]any{
		"lat": 12.98, "lng": 77.59,
	}, http.StatusOK)

	if str(updated, "name") != "Anita" {
		t.Fatalf("name after a pin-only patch = %q, want Anita", str(updated, "name"))
	}
	if str(updated, "address") == "" {
		t.Fatal("a pin-only patch blanked the address")
	}
	if num(updated, "lat") != 12.98 {
		t.Fatalf("lat = %v, want 12.98", num(updated, "lat"))
	}
}

func TestGenerationRespectsWeekdaysAndInactiveCustomers(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	// A subscription that runs only on a weekday that isn't today.
	todayWeekday := int(time.Now().UTC().Weekday())
	otherWeekday := (todayWeekday + 3) % 7

	scheduled := createCustomer(t, admin, "Scheduled Elsewhere", 12.98, 77.59)
	admin.mustDo(http.MethodPost, "/api/v1/recurring-orders", map[string]any{
		"customer_id": scheduled, "product_id": productID, "quantity": 1,
		"weekdays": []int{otherWeekday},
	}, http.StatusCreated)

	paused := createCustomer(t, admin, "Paused Customer", 12.99, 77.59)
	createSubscription(t, admin, paused, productID, 1)
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+paused, map[string]any{"active": false}, http.StatusOK)

	day := admin.mustDo(http.MethodPost, "/api/v1/day/generate", nil, http.StatusOK)
	summary, _ := day["summary"].(map[string]any)
	if got := num(summary, "total"); got != 0 {
		t.Fatalf("generated %v deliveries, want 0 (wrong weekday and an inactive customer)", got)
	}
}

func TestInvalidInputsAreRejected(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	customer := createCustomer(t, admin, "Customer", 12.98, 77.59)

	cases := []struct {
		name   string
		method string
		path   string
		body   any
		want   int
	}{
		{"customer with no name", http.MethodPost, "/api/v1/customers", map[string]any{"lat": 12.9, "lng": 77.5}, http.StatusBadRequest},
		{"customer off the globe", http.MethodPost, "/api/v1/customers", map[string]any{"name": "X", "lat": 991.0, "lng": 77.5}, http.StatusBadRequest},
		{"driver with a guessable pin", http.MethodPost, "/api/v1/drivers", map[string]any{"name": "D", "phone": "+919000000099", "pin": "111111"}, http.StatusBadRequest},
		{"driver with a short pin", http.MethodPost, "/api/v1/drivers", map[string]any{"name": "D", "phone": "+919000000098", "pin": "123"}, http.StatusBadRequest},
		{"subscription with no weekdays", http.MethodPost, "/api/v1/recurring-orders", map[string]any{"customer_id": customer, "product_id": productID, "quantity": 1, "weekdays": []int{}}, http.StatusBadRequest},
		{"subscription with zero quantity", http.MethodPost, "/api/v1/recurring-orders", map[string]any{"customer_id": customer, "product_id": productID, "quantity": 0, "weekdays": everyWeekday}, http.StatusBadRequest},
		{"subscription for an unknown customer", http.MethodPost, "/api/v1/recurring-orders", map[string]any{"customer_id": "nope", "product_id": productID, "quantity": 1, "weekdays": everyWeekday}, http.StatusNotFound},
		{"day for a malformed date", http.MethodGet, "/api/v1/day?date=20-08-2026", nil, http.StatusBadRequest},
		{"route with no stops", http.MethodPost, "/api/v1/routes", map[string]any{"start_lat": 12.97, "start_lng": 77.59}, http.StatusBadRequest},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec, _ := admin.do(tc.method, tc.path, tc.body)
			if rec.Code != tc.want {
				t.Fatalf("%s %s = %d, want %d (body: %s)", tc.method, tc.path, rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

// Duplicate phone numbers would make driver sign-in ambiguous, since the
// login screen has no tenant selector.
func TestDuplicateDriverPhoneIsRejected(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	admin.mustDo(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": "Ravi", "phone": "+919876543210", "pin": "481920",
	}, http.StatusCreated)

	rec, _ := admin.do(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": "Someone Else", "phone": "9876543210", "pin": "481921",
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate phone = %d, want 409", rec.Code)
	}
}

// Google endpoints must fail closed, with a clear reason, when the server
// has no client ID configured — never fall through to an unauthenticated
// session.
func TestGoogleEndpointsRefuseWhenUnconfigured(t *testing.T) {
	server := newTestServer(t)
	anonymous := &client{t: t, server: server}

	for _, path := range []string{"/api/v1/auth/google", "/api/v1/auth/signup"} {
		rec, decoded := anonymous.do(http.MethodPost, path, map[string]any{
			"id_token": "whatever", "business_name": "Test Dairy", "business_type": "dairy",
		})
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s with no GOOGLE_CLIENT_ID = %d, want 503", path, rec.Code)
		}
		if str(decoded, "code") != "google_not_configured" {
			t.Fatalf("%s error code = %q, want google_not_configured", path, str(decoded, "code"))
		}
	}
}
