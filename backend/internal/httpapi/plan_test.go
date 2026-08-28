package httpapi

import (
	"fmt"
	"net/http"
	"testing"
)

// planSetup makes a business with `n` pinned customers on a standing
// order, its home location set, and the day materialized.
func planSetup(t *testing.T, n int) *client {
	t.Helper()
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 12.9700, "home_lng": 77.5946,
	}, http.StatusOK)

	for i := 0; i < n; i++ {
		id := createCustomer(t, admin, fmt.Sprintf("House %d", i), 12.9750+float64(i)*0.004, 77.5946+float64(i%3)*0.004)
		createSubscription(t, admin, id, productID, 1)
	}
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	return admin
}

func TestPlanRoundsSplitsTheDayAcrossDrivers(t *testing.T) {
	admin := planSetup(t, 12)

	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 3}, http.StatusOK)
	routes, _ := day["routes"].([]any)
	if len(routes) != 3 {
		t.Fatalf("planned %d rounds, want 3", len(routes))
	}

	// Every pending delivery must land on one of them.
	summary, _ := day["summary"].(map[string]any)
	if got := num(summary, "unrouted"); got != 0 {
		t.Fatalf("unrouted = %v after planning, want 0", got)
	}

	perRound := map[string]int{}
	for _, stop := range stopsOf(t, day) {
		perRound[str(stop, "route_id")]++
	}
	for id, count := range perRound {
		if count == 0 {
			t.Fatalf("round %s got no stops", id)
		}
		if count > 4 { // ceil(12/3)
			t.Fatalf("round %s got %d stops, over the balance cap of 4", id, count)
		}
	}
}

// Re-planning is something an admin does when a driver calls in sick. It
// must replace the plan, not stack a second one beside it.
func TestPlanRoundsReplacesThePreviousPlan(t *testing.T) {
	admin := planSetup(t, 12)

	admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 4}, http.StatusOK)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 2}, http.StatusOK)

	routes, _ := day["routes"].([]any)
	if len(routes) != 2 {
		t.Fatalf("after re-planning to 2 there are %d rounds, want 2", len(routes))
	}
	summary, _ := day["summary"].(map[string]any)
	if got := num(summary, "total"); got != 12 {
		t.Fatalf("re-planning changed the delivery count to %v, want 12 — planning must not touch deliveries", got)
	}
	if got := num(summary, "unrouted"); got != 0 {
		t.Fatalf("unrouted = %v after re-planning, want 0", got)
	}
}

// Sending the driver home is a different route, not the same route with a
// bigger number attached.
func TestPlanRoundsReturnHomeCountsTheDriveBack(t *testing.T) {
	openAdmin := planSetup(t, 8)
	openDay := openAdmin.mustDo(http.MethodPost, "/api/v1/routes/plan",
		map[string]any{"count": 1, "return_home": false}, http.StatusOK)

	homeAdmin := planSetup(t, 8)
	homeDay := homeAdmin.mustDo(http.MethodPost, "/api/v1/routes/plan",
		map[string]any{"count": 1, "return_home": true}, http.StatusOK)

	openRoutes, _ := openDay["routes"].([]any)
	homeRoutes, _ := homeDay["routes"].([]any)
	openMeters := num(openRoutes[0].(map[string]any), "estimated_meters")
	homeMeters := num(homeRoutes[0].(map[string]any), "estimated_meters")

	if homeMeters <= openMeters {
		t.Fatalf("round trip is %v m, not longer than the one-way %v m — the drive home isn't counted", homeMeters, openMeters)
	}
}

// A delivery the driver already made keeps the round it was made on.
// Re-planning the morning must not rewrite what already happened.
func TestPlanRoundsLeavesCompletedWorkAlone(t *testing.T) {
	admin := planSetup(t, 6)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 2}, http.StatusOK)

	// Complete one stop, and remember which round it was on.
	var doneID, doneRoute string
	for _, stop := range stopsOf(t, day) {
		doneID, doneRoute = str(stop, "id"), str(stop, "route_id")
		break
	}
	admin.mustDo(http.MethodPatch, "/api/v1/orders/"+doneID, map[string]any{
		"status": "delivered",
	}, http.StatusOK)

	replanned := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 3}, http.StatusOK)
	for _, stop := range stopsOf(t, replanned) {
		if str(stop, "id") != doneID {
			continue
		}
		if str(stop, "status") != "delivered" {
			t.Fatalf("completed stop came back as %q after re-planning", str(stop, "status"))
		}
		if str(stop, "route_id") != doneRoute {
			t.Fatalf("completed stop moved from round %s to %s — history must not be re-cut", doneRoute, str(stop, "route_id"))
		}
	}
}

func TestPlanRoundsRejectsCountOutOfRange(t *testing.T) {
	admin := planSetup(t, 4)
	for _, count := range []int{0, -1, 11, 99} {
		admin.mustDo(http.MethodPost, "/api/v1/routes/plan",
			map[string]any{"count": count}, http.StatusBadRequest)
	}
}

// More rounds than there are stops degrades to one stop each rather than
// creating empty rounds nobody can drive.
func TestPlanMoreRoundsThanStops(t *testing.T) {
	admin := planSetup(t, 3)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 8}, http.StatusOK)
	routes, _ := day["routes"].([]any)
	if len(routes) != 3 {
		t.Fatalf("planned %d rounds for 3 stops, want 3", len(routes))
	}
}
