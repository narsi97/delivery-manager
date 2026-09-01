package httpapi

import (
	"net/http"
	"testing"
)

// The case that forced this: a dairy runs a morning round and an evening
// round over the same streets. No circle drawn on a map separates two
// customers on the same street, so a route has to be able to accept
// customers by name as well as by pin.
func TestTwoRoutesCanCoverTheSameStreets(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0575, "home_lng": 79.2684,
	}, http.StatusOK)

	morning := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda morning", "lat": 17.0575, "lng": 79.2684, "radius_meters": 6000,
	}, http.StatusCreated)
	evening := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda evening", "lat": 17.0575, "lng": 79.2684, "radius_meters": 6000,
	}, http.StatusCreated)

	// Two neighbours, metres apart, on different rounds.
	dayShift := createCustomer(t, admin, "Day Shift", 17.0580, 79.2690)
	nightShift := createCustomer(t, admin, "Night Shift", 17.0581, 79.2691)
	createSubscription(t, admin, dayShift, productID, 1)
	createSubscription(t, admin, nightShift, productID, 1)

	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+dayShift,
		map[string]any{"service_area_id": str(morning, "id")}, http.StatusOK)
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+nightShift,
		map[string]any{"service_area_id": str(evening, "id")}, http.StatusOK)

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	routeOf := map[string]string{}
	for _, rt := range routesOf(t, day) {
		routeOf[str(rt, "id")] = str(rt, "name")
	}
	on := map[string]string{}
	for _, stop := range stopsOf(t, day) {
		on[str(stop, "customer_name")] = routeOf[str(stop, "route_id")]
	}

	if on["Day Shift"] == on["Night Shift"] {
		t.Fatalf("both neighbours landed on %q — the hand assignment did nothing", on["Day Shift"])
	}
	if on["Day Shift"] == "" || on["Night Shift"] == "" {
		t.Fatalf("a customer is unrouted: %v", on)
	}
}

// Without a hand assignment nothing changes: the pin still decides, which
// is how every existing customer keeps working.
func TestAnUnassignedCustomerStillFollowsTheirPin(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0575, "home_lng": 79.2684,
	}, http.StatusOK)
	area := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0575, "lng": 79.2684, "radius_meters": 6000,
	}, http.StatusCreated)

	id := createCustomer(t, admin, "Ordinary", 17.0580, 79.2690)
	createSubscription(t, admin, id, productID, 1)

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	routes := routesOf(t, day)
	if len(routes) != 1 {
		t.Fatalf("%d routes prepared, want 1", len(routes))
	}
	stops := stopsOf(t, day)
	if len(stops) != 1 || str(stops[0], "route_id") == "" {
		t.Fatalf("the customer is not on the route their pin falls in (%s)", str(area, "name"))
	}
}

// A customer can be handed back to their pin, and a route can claim
// somebody whose pin is nowhere near it — which is what makes this a
// list rather than a circle.
func TestAssigningAndUnassigningACustomer(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0575, "home_lng": 79.2684,
	}, http.StatusOK)
	near := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0575, "lng": 79.2684, "radius_meters": 6000,
	}, http.StatusCreated)
	far := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Kodad", "lat": 17.5000, "lng": 79.9600, "radius_meters": 5000,
	}, http.StatusCreated)

	id := createCustomer(t, admin, "Traveller", 17.0580, 79.2690)
	createSubscription(t, admin, id, productID, 1)

	nameOfRoute := func() string {
		day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
		routeOf := map[string]string{}
		for _, rt := range routesOf(t, day) {
			routeOf[str(rt, "id")] = str(rt, "name")
		}
		for _, stop := range stopsOf(t, day) {
			if str(stop, "customer_name") == "Traveller" {
				return routeOf[str(stop, "route_id")]
			}
		}
		return ""
	}

	if got := nameOfRoute(); got == "" {
		t.Fatal("the customer starts unrouted")
	}

	// Put them on the far route, whose circle does not contain them.
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+id,
		map[string]any{"service_area_id": str(far, "id")}, http.StatusOK)
	if got := nameOfRoute(); got != "Kodad route" {
		t.Fatalf("after assigning to Kodad the customer is on %q", got)
	}

	// Empty string hands them back to their pin.
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+id,
		map[string]any{"service_area_id": ""}, http.StatusOK)
	if got := nameOfRoute(); got != "Nalgonda route" {
		t.Fatalf("after clearing the assignment the customer is on %q, want their pin's route", got)
	}
	_ = near
}

// A route id from another business can't be used to move a customer.
func TestAssigningRefusesAnotherBusinessesRoute(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := createCustomer(t, admin, "Mine", 17.058, 79.269)

	other := secondBusinessAdminClient(t, server)
	theirs := other.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Theirs", "lat": 17.0575, "lng": 79.2684, "radius_meters": 6000,
	}, http.StatusCreated)

	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+id,
		map[string]any{"service_area_id": str(theirs, "id")}, http.StatusNotFound)
}
