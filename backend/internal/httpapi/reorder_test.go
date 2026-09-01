package httpapi

import (
	"net/http"
	"sort"
	"testing"
)

// routeOrder returns the customer names on the day's first route, in the
// sequence a driver would work them.
func routeOrder(t *testing.T, day map[string]any) []string {
	t.Helper()
	type row struct {
		name string
		seq  int
	}
	rows := []row{}
	for _, stop := range stopsOf(t, day) {
		if str(stop, "route_id") == "" {
			continue
		}
		rows = append(rows, row{str(stop, "customer_name"), int(num(stop, "sequence"))})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].seq < rows[j].seq })
	out := []string{}
	for _, r := range rows {
		out = append(out, r.name)
	}
	return out
}

func reorderSetup(t *testing.T) (*client, map[string]any) {
	t.Helper()
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 17.0500, "home_lng": 79.2670,
	}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0500, "lng": 79.2670, "radius_meters": 8000,
	}, http.StatusCreated)
	for i, name := range []string{"Alpha", "Bravo", "Charlie", "Delta"} {
		id := createCustomer(t, admin, name, 17.0510+float64(i)*0.004, 79.2670)
		createSubscription(t, admin, id, productID, 1)
	}
	return admin, admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
}

func stopIDFor(t *testing.T, day map[string]any, customerName string) string {
	t.Helper()
	for _, stop := range stopsOf(t, day) {
		if str(stop, "customer_name") == customerName {
			return str(stop, "id")
		}
	}
	t.Fatalf("no stop for %q", customerName)
	return ""
}

// The plain case: pull a stop to the front because you know something
// the optimizer doesn't.
func TestAStopCanBeMovedToTheFront(t *testing.T) {
	admin, day := reorderSetup(t)
	before := routeOrder(t, day)
	last := before[len(before)-1]

	after := admin.mustDo(http.MethodPost, "/api/v1/orders/"+stopIDFor(t, day, last)+"/position",
		map[string]any{"position": 1}, http.StatusOK)

	got := routeOrder(t, after)
	if got[0] != last {
		t.Fatalf("order is %v — %q should have moved to the front", got, last)
	}
	if len(got) != len(before) {
		t.Fatalf("stop count changed from %d to %d", len(before), len(got))
	}
}

// Moving one stop must not lose or duplicate any other.
func TestMovingAStopKeepsEveryoneElse(t *testing.T) {
	admin, day := reorderSetup(t)
	before := routeOrder(t, day)

	after := admin.mustDo(http.MethodPost, "/api/v1/orders/"+stopIDFor(t, day, before[1])+"/position",
		map[string]any{"position": 4}, http.StatusOK)

	got := routeOrder(t, after)
	seen := map[string]int{}
	for _, n := range got {
		seen[n]++
	}
	for _, n := range before {
		if seen[n] != 1 {
			t.Fatalf("%q appears %d times after the move; order is %v", n, seen[n], got)
		}
	}
}

// Asking to move the first stop up is a normal thing to do. The useful
// answer is "it is already first", not an error.
func TestMovingBeyondTheEndsIsClamped(t *testing.T) {
	admin, day := reorderSetup(t)
	before := routeOrder(t, day)

	after := admin.mustDo(http.MethodPost, "/api/v1/orders/"+stopIDFor(t, day, before[0])+"/position",
		map[string]any{"position": 0}, http.StatusOK)
	if got := routeOrder(t, after); got[0] != before[0] {
		t.Fatalf("clamping to the front changed the order: %v", got)
	}

	after = admin.mustDo(http.MethodPost, "/api/v1/orders/"+stopIDFor(t, day, before[0])+"/position",
		map[string]any{"position": 99}, http.StatusOK)
	got := routeOrder(t, after)
	if got[len(got)-1] != before[0] {
		t.Fatalf("clamping past the end did not move it last: %v", got)
	}
}

// The part that makes hand-ordering worth anything: it survives. Reading
// the day again must not quietly re-sort what a person arranged.
func TestAHandArrangedRouteIsNotReoptimised(t *testing.T) {
	admin, day := reorderSetup(t)
	before := routeOrder(t, day)
	last := before[len(before)-1]

	admin.mustDo(http.MethodPost, "/api/v1/orders/"+stopIDFor(t, day, last)+"/position",
		map[string]any{"position": 1}, http.StatusOK)

	// Read the day again — this is what re-runs the route preparation.
	again := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	if got := routeOrder(t, again); got[0] != last {
		t.Fatalf("after re-reading the day the order is %v — the manual arrangement was lost", got)
	}
}

// A stop that arrives after the arrangement is appended, not slotted in
// by distance — the admin's order stays intact ahead of it.
func TestNewStopsAreAppendedToAHandArrangedRoute(t *testing.T) {
	admin, day := reorderSetup(t)
	before := routeOrder(t, day)
	last := before[len(before)-1]
	admin.mustDo(http.MethodPost, "/api/v1/orders/"+stopIDFor(t, day, last)+"/position",
		map[string]any{"position": 1}, http.StatusOK)

	// A new customer right beside the depot — distance would put them first.
	productID := firstProductID(t, admin)
	newID := createCustomer(t, admin, "Zulu", 17.0501, 79.2670)
	createSubscription(t, admin, newID, productID, 1)

	after := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	got := routeOrder(t, after)
	if got[0] != last {
		t.Fatalf("order is %v — the hand-placed stop should still be first", got)
	}
	if got[len(got)-1] != "Zulu" {
		t.Fatalf("order is %v — a new stop should be appended, not slotted in", got)
	}
}
