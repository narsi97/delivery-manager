package httpapi

import (
	"net/http"
	"testing"
)

// A customer put on a round by hand belongs to it whether or not anybody
// has dropped their pin yet. The office knows which round they are on
// before it knows which house they are in, and the driver is the person
// best placed to find out.
func TestHandAssignedCustomerJoinsTheRoundWithoutAPin(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0500, "home_lng": 79.2670,
	}, http.StatusOK)
	area := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0500, "lng": 79.2670, "radius_meters": 8000,
	}, http.StatusCreated)

	pinned := createCustomer(t, admin, "Has A Pin", 17.0510, 79.2670)
	createSubscription(t, admin, pinned, productID, 1)

	// No pin at all, but put on the round by hand.
	blind := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "No Pin Yet", "phone": "+919000000123", "address": "Ask at the temple",
		"service_area_id": str(area, "id"),
	}, http.StatusCreated)
	createSubscription(t, admin, str(blind, "id"), productID, 1)

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	var found, routed bool
	for _, stop := range stopsOf(t, day) {
		if str(stop, "customer_name") == "No Pin Yet" {
			found = true
			routed = str(stop, "route_id") != ""
		}
	}
	if !found {
		t.Fatal("the unpinned customer has no delivery today")
	}
	if !routed {
		t.Error("a customer assigned to a service route by hand should be on its round even without a pin")
	}

	summary, _ := day["summary"].(map[string]any)
	if num(summary, "unpinned") != 0 {
		t.Errorf("unpinned = %v, want 0 — they are on a round, so they can be routed", num(summary, "unpinned"))
	}
	if num(summary, "needs_pin") != 1 {
		t.Errorf("needs_pin = %v, want 1", num(summary, "needs_pin"))
	}
}

// Somebody with neither a pin nor an assignment still has nothing to
// place them by, and stays where an admin can see the problem.
func TestCustomerWithNoPinAndNoRouteStaysUnrouted(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0500, "lng": 79.2670, "radius_meters": 8000,
	}, http.StatusCreated)

	lost := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Nobody Knows", "phone": "+919000000124",
	}, http.StatusCreated)
	createSubscription(t, admin, str(lost, "id"), productID, 1)

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	for _, stop := range stopsOf(t, day) {
		if str(stop, "customer_name") == "Nobody Knows" && str(stop, "route_id") != "" {
			t.Error("a customer with no pin and no assignment should not land on a round")
		}
	}
	summary, _ := day["summary"].(map[string]any)
	if num(summary, "unpinned") != 1 {
		t.Errorf("unpinned = %v, want 1", num(summary, "unpinned"))
	}
}

// Without a pin there is no place in a shortest path, so they ride at
// the end rather than being wedged in among stops that do have one.
func TestUnpinnedStopsRideAtTheEndOfTheRound(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0500, "home_lng": 79.2670,
	}, http.StatusOK)
	area := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0500, "lng": 79.2670, "radius_meters": 8000,
	}, http.StatusCreated)

	for i, name := range []string{"Alpha", "Bravo", "Charlie"} {
		id := createCustomer(t, admin, name, 17.0510+float64(i)*0.004, 79.2670)
		createSubscription(t, admin, id, productID, 1)
	}
	blind := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Last Of All", "phone": "+919000000125", "service_area_id": str(area, "id"),
	}, http.StatusCreated)
	createSubscription(t, admin, str(blind, "id"), productID, 1)

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	highest, lastName := 0, ""
	for _, stop := range stopsOf(t, day) {
		if seq := int(num(stop, "sequence")); seq > highest {
			highest, lastName = seq, str(stop, "customer_name")
		}
	}
	if lastName != "Last Of All" {
		t.Errorf("the round ends at %q, want the stop with no pin", lastName)
	}
}
