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

// Two service routes over the same streets share a centre exactly, so a
// route could not be matched back to the one it was prepared for.
// Assigning a driver to the second left the first orphaned and empty
// beside a freshly created "(2)".
func TestAssigningADriverToAnOverlappingRouteLeavesTheOtherAlone(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0575, "home_lng": 79.2684,
	}, http.StatusOK)

	morning := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0575, "lng": 79.2684, "radius_meters": 6000,
	}, http.StatusCreated)
	evening := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda evening", "lat": 17.0575, "lng": 79.2684, "radius_meters": 6000,
	}, http.StatusCreated)

	early := createCustomer(t, admin, "Early Riser", 17.0580, 79.2690)
	late := createCustomer(t, admin, "Late Riser", 17.0581, 79.2691)
	createSubscription(t, admin, early, productID, 1)
	createSubscription(t, admin, late, productID, 1)
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+late,
		map[string]any{"service_area_id": str(evening, "id")}, http.StatusOK)
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	driver := driverWithHome(t, admin, "Kumar", "+91 90000 00002", 17.0500, 79.2600)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+str(evening, "id")+"/drivers",
		map[string]any{"driver_ids": []string{driver}}, http.StatusOK)

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	routes := routesOf(t, day)
	// The evening route is the one that got a driver; the morning one
	// must be untouched, and there must be no third route.
	assignedTo := map[string]string{}
	for _, rt := range routes {
		assignedTo[str(rt, "name")] = str(rt, "driver_id")
	}
	if assignedTo["Nalgonda evening route"] != driver {
		t.Fatalf("the evening route's driver is %q, want the one just assigned", assignedTo["Nalgonda evening route"])
	}
	if assignedTo["Nalgonda route"] != "" {
		t.Fatalf("assigning the evening route also assigned the morning one")
	}
	if len(routes) != 2 {
		names := []string{}
		for _, rt := range routes {
			names = append(names, str(rt, "name"))
		}
		t.Fatalf("%d routes after assigning one of two overlapping service routes: %v", len(routes), names)
	}

	// Every route still carries its stop, and the morning one was not
	// touched by a change to the evening one.
	counts := map[string]int{}
	routeName := map[string]string{}
	for _, rt := range routes {
		routeName[str(rt, "id")] = str(rt, "name")
	}
	for _, stop := range stopsOf(t, day) {
		if rid := str(stop, "route_id"); rid != "" {
			counts[routeName[rid]]++
		}
	}
	// One driver keeps the plain name — "· Driver" is what a split
	// between several produces.
	for name, want := range map[string]int{"Nalgonda route": 1, "Nalgonda evening route": 1} {
		if counts[name] != want {
			t.Fatalf("%q holds %d stops, want %d (all routes: %v)", name, counts[name], want, counts)
		}
	}
	_ = morning
}

// A phone number or address, once saved, could never be removed: an
// empty string on PATCH was read as "not sent". Undo depends on this —
// putting a field back the way it was means being able to put it back
// to empty.
func TestAPhoneAndAddressCanBeCleared(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	created := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Anitha", "phone": "9694451276", "address": "115, NG College Road", "lat": 17.058, "lng": 79.269,
	}, http.StatusCreated)
	id := str(created, "id")

	cleared := admin.mustDo(http.MethodPatch, "/api/v1/customers/"+id,
		map[string]any{"phone": "", "address": ""}, http.StatusOK)
	if str(cleared, "phone") != "" || str(cleared, "address") != "" {
		t.Fatalf("phone %q and address %q survived being cleared", str(cleared, "phone"), str(cleared, "address"))
	}

	// And a PATCH that doesn't mention them still leaves them alone.
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+id,
		map[string]any{"phone": "9000000001", "address": "Somewhere"}, http.StatusOK)
	pinned := admin.mustDo(http.MethodPatch, "/api/v1/customers/"+id,
		map[string]any{"lat": 17.06, "lng": 79.27}, http.StatusOK)
	if str(pinned, "phone") != "9000000001" || str(pinned, "address") != "Somewhere" {
		t.Fatalf("dropping a pin wiped the contact details: %q / %q", str(pinned, "phone"), str(pinned, "address"))
	}
}
