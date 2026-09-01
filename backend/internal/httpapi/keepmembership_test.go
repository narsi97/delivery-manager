package httpapi

import (
	"net/http"
	"testing"
)

// customerRoutes returns which route name each customer's delivery is on.
func customerRoutes(t *testing.T, admin *client) map[string]string {
	t.Helper()
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	names := map[string]string{}
	for _, rt := range routesOf(t, day) {
		names[str(rt, "id")] = str(rt, "name")
	}
	out := map[string]string{}
	for _, stop := range stopsOf(t, day) {
		out[str(stop, "customer_name")] = names[str(stop, "route_id")]
	}
	return out
}

// townSetup: one settled service route with four customers on it.
func townSetup(t *testing.T) (*client, []string) {
	t.Helper()
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0575, "home_lng": 79.2684,
	}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0575, "lng": 79.2684, "radius_meters": 6000,
	}, http.StatusCreated)

	ids := []string{}
	// Two near the existing centre, two out east — the east pair is what
	// a second circle drawn to the east would otherwise steal.
	for i, spec := range []struct {
		name     string
		lat, lng float64
	}{
		{"West One", 17.0570, 79.2650},
		{"West Two", 17.0572, 79.2660},
		{"East One", 17.0580, 79.2900},
		{"East Two", 17.0582, 79.2910},
	} {
		id := createCustomer(t, admin, spec.name, spec.lat, spec.lng)
		createSubscription(t, admin, id, productID, 1)
		ids = append(ids, id)
		_ = i
	}
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	return admin, ids
}

// The bug a real owner hit: draw a second circle over a town you already
// deliver to, and it quietly takes whichever customers sit closer to the
// new middle — off a round that was already settled.
func TestANewRouteDoesNotTakeCustomersFromASettledOne(t *testing.T) {
	admin, _ := townSetup(t)

	before := customerRoutes(t, admin)
	for name, route := range before {
		if route != "Nalgonda route" {
			t.Fatalf("%s starts on %q, want the only route there is", name, route)
		}
	}

	created := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda evening", "lat": 17.0581, "lng": 79.2905, "radius_meters": 6000,
	}, http.StatusCreated)

	after := customerRoutes(t, admin)
	for name, route := range before {
		if after[name] != route {
			t.Fatalf("%s moved from %q to %q just because a route was created", name, route, after[name])
		}
	}

	// And the response says who it passed over, so the screen can offer.
	kept, _ := created["kept"].([]any)
	if len(kept) != 2 {
		t.Fatalf("reported %d kept customers, want the 2 the new circle would have taken", len(kept))
	}
	names := map[string]bool{}
	for _, k := range kept {
		entry := k.(map[string]any)
		names[str(entry, "customer_name")] = true
		if str(entry, "route_name") != "Nalgonda" {
			t.Fatalf("kept entry names route %q, want the one they stayed on", str(entry, "route_name"))
		}
	}
	if !names["East One"] || !names["East Two"] {
		t.Fatalf("kept the wrong customers: %v", names)
	}
}

// The case that makes drawing a circle worth doing still works: a route
// claims customers nobody was delivering to.
func TestANewRouteStillClaimsUncoveredCustomers(t *testing.T) {
	admin, _ := townSetup(t)
	productID := firstProductID(t, admin)

	// Far outside the existing circle — on no route at all.
	stray := createCustomer(t, admin, "Kodad One", 17.5000, 79.9600)
	createSubscription(t, admin, stray, productID, 1)
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	if got := customerRoutes(t, admin)["Kodad One"]; got != "" {
		t.Fatalf("the stray starts on %q, want no route", got)
	}

	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Kodad", "lat": 17.5000, "lng": 79.9600, "radius_meters": 5000,
	}, http.StatusCreated)

	if got := customerRoutes(t, admin)["Kodad One"]; got != "Kodad route" {
		t.Fatalf("the stray is on %q, want the new route to have claimed them", got)
	}
}

// Having been passed over, they can be handed to the new route in one go.
func TestCustomersCanBeMovedOntoANewRoute(t *testing.T) {
	admin, _ := townSetup(t)

	created := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda evening", "lat": 17.0581, "lng": 79.2905, "radius_meters": 6000,
	}, http.StatusCreated)

	kept, _ := created["kept"].([]any)
	ids := []string{}
	for _, k := range kept {
		ids = append(ids, str(k.(map[string]any), "customer_id"))
	}

	admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+str(created, "id")+"/customers",
		map[string]any{"customer_ids": ids}, http.StatusOK)

	after := customerRoutes(t, admin)
	for _, name := range []string{"East One", "East Two"} {
		if after[name] != "Nalgonda evening route" {
			t.Fatalf("%s is on %q after being moved, want the evening route", name, after[name])
		}
	}
	for _, name := range []string{"West One", "West Two"} {
		if after[name] != "Nalgonda route" {
			t.Fatalf("%s moved to %q — only the named customers should have moved", name, after[name])
		}
	}
}

// The very first service route has nobody to take customers from.
func TestTheFirstRouteReportsNothingKept(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0575, "home_lng": 79.2684,
	}, http.StatusOK)
	id := createCustomer(t, admin, "First", 17.0580, 79.2690)
	createSubscription(t, admin, id, productID, 1)

	created := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0575, "lng": 79.2684, "radius_meters": 6000,
	}, http.StatusCreated)
	if kept, _ := created["kept"].([]any); len(kept) != 0 {
		t.Fatalf("the first route reported %d kept customers", len(kept))
	}
	if got := customerRoutes(t, admin)["First"]; got != "Nalgonda route" {
		t.Fatalf("the first route did not claim its customer (%q)", got)
	}
}
