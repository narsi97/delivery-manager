package httpapi

import (
	"net/http"
	"testing"

	"delivery-manager/internal/domain"
)

// The headline: a shop that opens at six is visited before the houses
// next door to the depot, even though the shortest path says otherwise.
func TestBusinessCustomersAreVisitedFirst(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0500, "home_lng": 79.2670,
	}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0700, "lng": 79.2670, "radius_meters": 9000,
	}, http.StatusCreated)

	// Two ordinary customers right beside the depot...
	for i, name := range []string{"Near One", "Near Two"} {
		id := createCustomer(t, admin, name, 17.0502+float64(i)*0.0005, 79.2671)
		createSubscription(t, admin, id, productID, 1)
	}
	// ...and a shop well out of the way, which would ordinarily be last.
	shop := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Corner Shop", "phone": "+919000000001", "address": "Market",
		"lat": 17.0900, "lng": 79.2671, "priority": "business",
	}, http.StatusCreated)
	createSubscription(t, admin, str(shop, "id"), productID, 1)

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	stops := stopsOf(t, day)
	if len(stops) != 3 {
		t.Fatalf("got %d stops, want 3", len(stops))
	}

	// Whichever route they landed on, the shop must be first on it.
	first := ""
	best := 1 << 30
	for _, stop := range stops {
		if seq := int(num(stop, "sequence")); seq < best {
			best, first = seq, str(stop, "customer_name")
		}
	}
	if first != "Corner Shop" {
		t.Fatalf("first stop is %q, want Corner Shop — a business tier must beat the shortest path", first)
	}
}

// Tiers are honoured in order, and the ordinary customers still come
// last however convenient they are.
func TestEarlyCustomersComeAfterBusinessAndBeforeNormal(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0500, "home_lng": 79.2670,
	}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0700, "lng": 79.2670, "radius_meters": 9000,
	}, http.StatusCreated)

	make := func(name string, lat float64, priority string) {
		body := map[string]any{"name": name, "phone": "+9190000000" + name[:1], "lat": lat, "lng": 79.2671}
		if priority != "" {
			body["priority"] = priority
		}
		c := admin.mustDo(http.MethodPost, "/api/v1/customers", body, http.StatusCreated)
		createSubscription(t, admin, str(c, "id"), productID, 1)
	}
	make("Alpha shop", 17.0900, "business")
	make("Bravo school family", 17.0850, "early")
	make("Charlie ordinary", 17.0502, "")

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	order := map[string]int{}
	for _, stop := range stopsOf(t, day) {
		order[str(stop, "customer_name")] = int(num(stop, "sequence"))
	}

	if !(order["Alpha shop"] < order["Bravo school family"]) {
		t.Fatalf("business (%d) did not come before early (%d)", order["Alpha shop"], order["Bravo school family"])
	}
	if !(order["Bravo school family"] < order["Charlie ordinary"]) {
		t.Fatalf("early (%d) did not come before normal (%d)", order["Bravo school family"], order["Charlie ordinary"])
	}
}

// Priority survives a pin-drop. PATCHing only lat/lng is the "drop the
// pin at the door" path, and it must not quietly demote a shop.
func TestUpdatingThePinKeepsThePriority(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	shop := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Corner Shop", "lat": 17.09, "lng": 79.26, "priority": "business",
	}, http.StatusCreated)

	moved := admin.mustDo(http.MethodPatch, "/api/v1/customers/"+str(shop, "id"), map[string]any{
		"lat": 17.10, "lng": 79.27,
	}, http.StatusOK)
	if got := str(moved, "priority"); got != string(domain.PriorityBusiness) {
		t.Fatalf("priority after a pin-only patch = %q, want business", got)
	}
}

func TestPriorityRejectsWhatIsNotATier(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	rec, _ := admin.do(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "X", "lat": 17.09, "lng": 79.26, "priority": "urgent",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("an unknown tier = %d, want 400", rec.Code)
	}
}

// A customer created before priorities existed reads back as normal
// rather than as an empty tier that sorts unpredictably.
func TestCustomersDefaultToNormalPriority(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	c := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Plain", "lat": 17.09, "lng": 79.26,
	}, http.StatusCreated)
	if got := str(c, "priority"); got != string(domain.PriorityNormal) {
		t.Fatalf("default priority = %q, want normal", got)
	}
}
