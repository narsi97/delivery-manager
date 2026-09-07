package httpapi

import (
	"net/http"
	"testing"
)

// The gate. Hiding the buttons in the app is not a safety catch — this
// is the one that matters, because it is the one a browser cannot talk
// its way past.
func TestDeletingIsRefusedUntilItIsSwitchedOn(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := createCustomer(t, admin, "Anita", 17.05, 79.26)

	admin.mustDo(http.MethodDelete, "/api/v1/customers/"+id, nil, http.StatusForbidden)

	after := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	if list, _ := after["customers"].([]any); len(list) != 1 {
		t.Fatalf("customer count %d, want 1 — nothing should have been deleted", len(list))
	}

	admin.mustDo(http.MethodPost, "/api/v1/account/delete-mode", map[string]any{"hours": 1}, http.StatusOK)
	admin.mustDo(http.MethodDelete, "/api/v1/customers/"+id, nil, http.StatusOK)

	after = admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	if list, _ := after["customers"].([]any); len(list) != 0 {
		t.Errorf("customer count %d, want 0", len(list))
	}
}

// Only the windows the screen offers. A caller asking for a year is
// asking for the catch to be off permanently, which is the thing this
// exists to prevent.
func TestDeleteWindowIsOneOfThreeLengths(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	for _, hours := range []int{1, 4, 24} {
		admin.mustDo(http.MethodPost, "/api/v1/account/delete-mode",
			map[string]any{"hours": hours}, http.StatusOK)
	}
	for _, hours := range []int{2, 48, 8760, -1} {
		admin.mustDo(http.MethodPost, "/api/v1/account/delete-mode",
			map[string]any{"hours": hours}, http.StatusBadRequest)
	}
}

// Turning it off takes effect on the next request, not the next sign-in.
func TestSwitchingDeleteModeOffClosesItImmediately(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := createCustomer(t, admin, "Anita", 17.05, 79.26)

	admin.mustDo(http.MethodPost, "/api/v1/account/delete-mode", map[string]any{"hours": 4}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/account/delete-mode", map[string]any{"hours": 0}, http.StatusOK)
	admin.mustDo(http.MethodDelete, "/api/v1/customers/"+id, nil, http.StatusForbidden)
}

// A customer goes with everything that was only ever about them.
func TestDeletingACustomerTakesTheirOrdersWithThem(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	id := createCustomer(t, admin, "Anita", 17.05, 79.26)
	createSubscription(t, admin, id, productID, 2)
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK) // materialize today

	preview := admin.mustDo(http.MethodGet, "/api/v1/customers/"+id+"/delete-preview", nil, http.StatusOK)
	if num(preview, "standing_orders") != 1 {
		t.Errorf("preview standing_orders = %v, want 1", num(preview, "standing_orders"))
	}
	if num(preview, "deliveries") < 1 {
		t.Errorf("preview deliveries = %v, want at least today's", num(preview, "deliveries"))
	}

	admin.mustDo(http.MethodPost, "/api/v1/account/delete-mode", map[string]any{"hours": 1}, http.StatusOK)
	admin.mustDo(http.MethodDelete, "/api/v1/customers/"+id, nil, http.StatusOK)

	orders := admin.mustDo(http.MethodGet, "/api/v1/recurring-orders", nil, http.StatusOK)
	if list, _ := orders["recurring_orders"].([]any); len(list) != 0 {
		t.Errorf("%d standing orders survived the customer", len(list))
	}
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	for _, stop := range stopsOf(t, day) {
		if str(stop, "customer_name") == "Anita" {
			t.Error("a delivery survived the customer it was for")
		}
	}
}

// Either of these locks a business out of its own account, and there is
// no signup to recover through.
func TestYouCannotDeleteYourselfOrTheLastAdmin(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	admin.mustDo(http.MethodPost, "/api/v1/account/delete-mode", map[string]any{"hours": 1}, http.StatusOK)

	me := admin.mustDo(http.MethodGet, "/api/v1/auth/me", nil, http.StatusOK)
	user, _ := me["user"].(map[string]any)
	admin.mustDo(http.MethodDelete, "/api/v1/drivers/"+str(user, "id"), nil, http.StatusBadRequest)

	// A driver is not an admin, so deleting one is fine.
	driverID := makeDriver(t, admin, "Kumar", "+919876543210")
	admin.mustDo(http.MethodDelete, "/api/v1/drivers/"+driverID, nil, http.StatusOK)
}

// A driver's rounds stay, with nobody driving them — a state this app
// already draws. Losing the round as well would lose the day's work.
func TestDeletingADriverLeavesTheirRoundStanding(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0500, "home_lng": 79.2670,
	}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0500, "lng": 79.2670, "radius_meters": 8000,
	}, http.StatusCreated)
	id := createCustomer(t, admin, "Anita", 17.0510, 79.2670)
	createSubscription(t, admin, id, productID, 1)

	driverID := makeDriver(t, admin, "Kumar", "+919876543210")
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	routeID := routeIDs(t, day)[0]
	admin.mustDo(http.MethodPost, "/api/v1/routes/"+routeID+"/assign",
		map[string]any{"driver_id": driverID}, http.StatusOK)

	admin.mustDo(http.MethodPost, "/api/v1/account/delete-mode", map[string]any{"hours": 1}, http.StatusOK)
	admin.mustDo(http.MethodDelete, "/api/v1/drivers/"+driverID, nil, http.StatusOK)

	after := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	if len(stopsOf(t, after)) == 0 {
		t.Error("the day's deliveries went with the driver")
	}
}

// customers.service_area_id carries no foreign key, so a delete that
// forgot it would leave a dangling id — which quietly changes which
// round somebody is on.
func TestDeletingAServiceRouteHandsItsCustomersBackToTheirPins(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	area := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0500, "lng": 79.2670, "radius_meters": 8000,
	}, http.StatusCreated)

	pinned := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Anita", "phone": "+919000000001", "lat": 17.051, "lng": 79.267,
		"service_area_id": str(area, "id"),
	}, http.StatusCreated)
	createSubscription(t, admin, str(pinned, "id"), productID, 1)

	admin.mustDo(http.MethodPost, "/api/v1/account/delete-mode", map[string]any{"hours": 1}, http.StatusOK)
	result := admin.mustDo(http.MethodDelete, "/api/v1/service-areas/"+str(area, "id"), nil, http.StatusOK)
	if num(result, "unassigned") != 1 {
		t.Errorf("unassigned = %v, want 1", num(result, "unassigned"))
	}

	after := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	list, _ := after["customers"].([]any)
	if len(list) != 1 {
		t.Fatalf("the customer went with the route")
	}
	c, _ := list[0].(map[string]any)
	if str(c, "service_area_id") != "" {
		t.Errorf("service_area_id = %q, want it cleared — that id points at nothing now", str(c, "service_area_id"))
	}
}
