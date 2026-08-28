package httpapi

import (
	"net/http"
	"testing"
)

// Deleting a route frees its deliveries rather than destroying them.
func TestDeleteRouteFreesItsDeliveries(t *testing.T) {
	admin := planSetup(t, 8)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 2}, http.StatusOK)

	ids := routeIDs(t, day)
	doomed := ids[0]
	freed := countOnRoute(t, day, doomed)

	after := admin.mustDo(http.MethodDelete, "/api/v1/routes/"+doomed, nil, http.StatusOK)

	if len(routeIDs(t, after)) != 1 {
		t.Fatalf("%d routes left, want 1", len(routeIDs(t, after)))
	}
	summary, _ := after["summary"].(map[string]any)
	if got := num(summary, "total"); got != 8 {
		t.Fatalf("deleting a route changed the delivery count to %v, want 8", got)
	}
	if got := num(summary, "unrouted"); got != float64(freed) {
		t.Fatalf("unrouted = %v after deleting a route of %d, want %d", got, freed, freed)
	}
}

// A route carrying completed work is the record of where those
// deliveries were made. Deleting it would detach them silently.
func TestDeleteRouteWithCompletedWorkIsRefused(t *testing.T) {
	admin := planSetup(t, 6)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 2}, http.StatusOK)

	target := routeIDs(t, day)[0]
	done := stopOnRoute(t, day, target)
	admin.mustDo(http.MethodPatch, "/api/v1/orders/"+done,
		map[string]any{"status": "delivered"}, http.StatusOK)

	admin.mustDo(http.MethodDelete, "/api/v1/routes/"+target, nil, http.StatusBadRequest)
}

// Reset clears the day so an admin who has made a mess can start over.
func TestResetClearsTheDaysRoutes(t *testing.T) {
	admin := planSetup(t, 10)
	admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 4}, http.StatusOK)

	after := admin.mustDo(http.MethodPost, "/api/v1/routes/reset", nil, http.StatusOK)

	if got := len(routeIDs(t, after)); got != 0 {
		t.Fatalf("%d routes left after reset, want 0 — no service areas are set up here", got)
	}
	summary, _ := after["summary"].(map[string]any)
	if got := num(summary, "total"); got != 10 {
		t.Fatalf("reset changed the delivery count to %v, want 10", got)
	}
	if got := num(summary, "unrouted"); got != 10 {
		t.Fatalf("unrouted = %v after reset, want 10", got)
	}
}

// Reset keeps routes that carry completed work, for the same reason
// delete refuses them.
func TestResetKeepsRoutesWithCompletedWork(t *testing.T) {
	admin := planSetup(t, 8)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 2}, http.StatusOK)

	keep := routeIDs(t, day)[0]
	done := stopOnRoute(t, day, keep)
	admin.mustDo(http.MethodPatch, "/api/v1/orders/"+done,
		map[string]any{"status": "delivered"}, http.StatusOK)

	after := admin.mustDo(http.MethodPost, "/api/v1/routes/reset", nil, http.StatusOK)

	left := routeIDs(t, after)
	if len(left) != 1 || left[0] != keep {
		t.Fatalf("reset left %v, want just the route with completed work (%s)", left, keep)
	}
}

// With service areas set up, reset means "back to the automatic plan"
// rather than "no routes at all" — which is what an admin who wants to
// undo their manual planning actually wants.
func TestResetFallsBackToServiceAreaRoutes(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 12.9700, "home_lng": 77.5946,
	}, http.StatusOK)
	createArea(t, admin, "Northtown", 12.9800, 77.5946, 3000)

	for i := 0; i < 6; i++ {
		id := createCustomer(t, admin, "House", 12.9790+float64(i)*0.0002, 77.5946)
		createSubscription(t, admin, id, productID, 1)
	}
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 3}, http.StatusOK)

	admin.mustDo(http.MethodPost, "/api/v1/routes/reset", nil, http.StatusOK)
	back := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	routes, _ := back["routes"].([]any)
	if len(routes) != 1 {
		t.Fatalf("after reset there are %d routes, want 1 (the service area's own)", len(routes))
	}
	if got := str(routes[0].(map[string]any), "name"); got != "Northtown route" {
		t.Fatalf("route after reset is %q, want %q", got, "Northtown route")
	}
}
