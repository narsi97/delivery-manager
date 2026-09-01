package httpapi

import (
	"net/http"
	"testing"

	"delivery-manager/internal/domain"
)

// The default that matters: a driver finishes back at the farm, because
// undelivered stock and empty bottles have to be handed over somewhere
// that isn't their kitchen. Pinning a home must not change that on its
// own — a home is a fact about the person, not a decision about the round.
func TestDriversFinishAtTheFarmByDefault(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0500, "home_lng": 79.2670,
	}, http.StatusOK)

	driverID := makeDriver(t, admin, "Ravi", "+919000000021")
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+driverID+"/home",
		map[string]any{"home_lat": 17.0900, "home_lng": 79.3100}, http.StatusOK)

	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0500, "lng": 79.2670, "radius_meters": 8000,
	}, http.StatusCreated)
	productID := firstProductID(t, admin)
	c := createCustomer(t, admin, "Anita", 17.0600, 79.2700)
	createSubscription(t, admin, c, productID, 1)
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	routeID := routeIDs(t, day)[0]
	assigned := admin.mustDo(http.MethodPost, "/api/v1/routes/"+routeID+"/assign",
		map[string]any{"driver_id": driverID}, http.StatusOK)

	if got := num(assigned, "end_lat"); got != 17.0500 {
		t.Fatalf("route ends at lat %v, want the farm's 17.05 — the driver's home should not be assumed", got)
	}
}

func TestChoosingHomeEndsTheRouteThere(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0500, "home_lng": 79.2670,
	}, http.StatusOK)

	driverID := makeDriver(t, admin, "Ravi", "+919000000022")
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+driverID+"/home",
		map[string]any{"home_lat": 17.0900, "home_lng": 79.3100}, http.StatusOK)
	updated := admin.mustDo(http.MethodPost, "/api/v1/drivers/"+driverID+"/finish",
		map[string]any{"finish_at": "home"}, http.StatusOK)
	if got := str(updated, "finish_at"); got != string(domain.FinishAtHome) {
		t.Fatalf("finish_at = %q, want home", got)
	}

	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0500, "lng": 79.2670, "radius_meters": 8000,
	}, http.StatusCreated)
	productID := firstProductID(t, admin)
	c := createCustomer(t, admin, "Anita", 17.0600, 79.2700)
	createSubscription(t, admin, c, productID, 1)
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	assigned := admin.mustDo(http.MethodPost, "/api/v1/routes/"+routeIDs(t, day)[0]+"/assign",
		map[string]any{"driver_id": driverID}, http.StatusOK)
	if got := num(assigned, "end_lat"); got != 17.0900 {
		t.Fatalf("route ends at lat %v, want the driver's home 17.09", got)
	}
}

func TestCustomFinishNeedsAPin(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	driverID := makeDriver(t, admin, "Ravi", "+919000000023")

	// Custom with no pin is a setting that cannot be honoured, and
	// silently falling back to the farm would contradict the screen.
	rec, _ := admin.do(http.MethodPost, "/api/v1/drivers/"+driverID+"/finish",
		map[string]any{"finish_at": "custom"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("custom finish with no pin = %d, want 400", rec.Code)
	}

	ok := admin.mustDo(http.MethodPost, "/api/v1/drivers/"+driverID+"/finish",
		map[string]any{"finish_at": "custom", "finish_lat": 17.11, "finish_lng": 79.33}, http.StatusOK)
	if got := num(ok, "finish_lat"); got != 17.11 {
		t.Fatalf("finish_lat = %v, want 17.11", got)
	}
}

// Choosing home while having no home pinned leaves the route open-ended
// rather than sending the driver to 0,0 in the Gulf of Guinea.
func TestHomeFinishWithNoHomeLeavesTheRouteOpen(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0500, "home_lng": 79.2670,
	}, http.StatusOK)

	driverID := makeDriver(t, admin, "Ravi", "+919000000024")
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+driverID+"/finish",
		map[string]any{"finish_at": "home"}, http.StatusOK)

	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0500, "lng": 79.2670, "radius_meters": 8000,
	}, http.StatusCreated)
	productID := firstProductID(t, admin)
	c := createCustomer(t, admin, "Anita", 17.0600, 79.2700)
	createSubscription(t, admin, c, productID, 1)
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	assigned := admin.mustDo(http.MethodPost, "/api/v1/routes/"+routeIDs(t, day)[0]+"/assign",
		map[string]any{"driver_id": driverID}, http.StatusOK)
	if num(assigned, "end_lat") != 0 || num(assigned, "end_lng") != 0 {
		t.Fatalf("route ended at %v,%v — with no home pinned it should stay open-ended",
			num(assigned, "end_lat"), num(assigned, "end_lng"))
	}
}

// The three packet sizes a dairy actually sells, and nothing else.
func TestDairyStartsWithThreeMilkSizes(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	resp := admin.mustDo(http.MethodGet, "/api/v1/products", nil, http.StatusOK)
	products, _ := resp["products"].([]any)
	names := map[string]bool{}
	for _, raw := range products {
		names[str(raw.(map[string]any), "name")] = true
	}
	for _, want := range []string{"Milk 500ml", "Milk 750ml", "Milk 1L"} {
		if !names[want] {
			t.Fatalf("a new dairy has no %q — got %v", want, names)
		}
	}
	if len(products) != 3 {
		t.Fatalf("a new dairy starts with %d products, want just the 3 milk sizes", len(products))
	}
}
