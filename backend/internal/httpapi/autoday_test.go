package httpapi

import (
	"net/http"
	"sync"
	"testing"
)

// Reading a day is what materializes it. There is no "generate" step an
// admin has to remember: a delivery business has deliveries every day, so
// asking what today looks like is the same act as working it out.
func TestGetDayGeneratesWithoutAnExplicitGenerate(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	customer := createCustomer(t, admin, "Anita", 12.9750, 77.5946)
	createSubscription(t, admin, customer, productID, 2)

	// Note: no POST to /day/generate anywhere in this test.
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	summary, _ := day["summary"].(map[string]any)
	if got := num(summary, "total"); got != 1 {
		t.Fatalf("GET /day produced %v deliveries, want 1 — reading a day must materialize it", got)
	}
	if got := num(summary, "pending"); got != 1 {
		t.Fatalf("%v pending, want 1", got)
	}
}

// Generating on read must stay idempotent: reading the same day twice
// cannot double up the work. EnsureDailyOrder is what guarantees this;
// this test is the guard that nobody replaces it with a plain create.
func TestGetDayTwiceDoesNotDuplicateDeliveries(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	customer := createCustomer(t, admin, "Anita", 12.9750, 77.5946)
	createSubscription(t, admin, customer, productID, 2)

	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	summary, _ := day["summary"].(map[string]any)
	if got := num(summary, "total"); got != 1 {
		t.Fatalf("after two reads there are %v deliveries, want 1", got)
	}
}

// createArea declares a delivery zone. Rounds are derived from these —
// one per area that has work in it — so a test about routing has to set
// them up the same way a real business would.
func createArea(t *testing.T, admin *client, name string, lat, lng, radius float64) string {
	t.Helper()
	created := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": name, "lat": lat, "lng": lng, "radius_meters": radius,
	}, http.StatusCreated)
	return str(created, "id")
}

// Rounds recur. A business that runs a Kodad round and a Miryalguda round
// runs them every day, so reading any day prepares one round per area
// that has deliveries in it — nobody hand-builds tomorrow's rounds.
func TestRoundsArePreparedPerServiceAreaOnRead(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	createArea(t, admin, "Northtown", 12.9800, 77.5946, 3000)
	createArea(t, admin, "Southtown", 12.9000, 77.5946, 3000)

	north := createCustomer(t, admin, "North House", 12.9810, 77.5946)
	south := createCustomer(t, admin, "South House", 12.9010, 77.5946)
	createSubscription(t, admin, north, productID, 1)
	createSubscription(t, admin, south, productID, 1)

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	routes, _ := day["routes"].([]any)
	if len(routes) != 2 {
		t.Fatalf("prepared %d rounds, want 2 — one per service area with work in it", len(routes))
	}

	names := map[string]bool{}
	for _, raw := range routes {
		rt, _ := raw.(map[string]any)
		names[str(rt, "name")] = true
	}
	for _, want := range []string{"Northtown route", "Southtown route"} {
		if !names[want] {
			t.Fatalf("no round named %q; got %v", want, names)
		}
	}

	summary, _ := day["summary"].(map[string]any)
	if got := num(summary, "unrouted"); got != 0 {
		t.Fatalf("unrouted = %v, want 0 — both customers sit inside an area", got)
	}
}

// The bug this replaced: with only one round in existence, "nearest
// round wins" put a customer 60km away on it, because it was the only
// round there was. A stop must only ever join a round that serves the
// same area the stop is in.
func TestStopDoesNotJoinARoundInADifferentArea(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	// Only the northern area is declared. The southern customer is far
	// outside it, and there is no round for them at all.
	createArea(t, admin, "Northtown", 12.9800, 77.5946, 3000)

	north := createCustomer(t, admin, "North House", 12.9810, 77.5946)
	faraway := createCustomer(t, admin, "Faraway House", 12.4000, 77.5946)
	createSubscription(t, admin, north, productID, 1)
	createSubscription(t, admin, faraway, productID, 1)

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	routes, _ := day["routes"].([]any)
	if len(routes) != 1 {
		t.Fatalf("prepared %d rounds, want 1 — only one area is declared", len(routes))
	}
	northRound, _ := routes[0].(map[string]any)
	roundID := str(northRound, "id")

	onRound, unrouted := 0, 0
	for _, stop := range stopsOf(t, day) {
		if str(stop, "route_id") == roundID {
			onRound++
			if str(stop, "customer_id") == faraway {
				t.Fatal("the faraway customer was put on the Northtown round — a stop must not join a round serving a different area")
			}
		} else if str(stop, "route_id") == "" {
			unrouted++
		}
	}
	if onRound != 1 {
		t.Fatalf("%d stops on the Northtown round, want 1", onRound)
	}
	if unrouted != 1 {
		t.Fatalf("%d unrouted, want 1 — the faraway customer stays visible for a human to place", unrouted)
	}
}

// A customer added after the round already exists must end up on it on
// the next read, with no Rebuild press. This is the gap that made "add a
// customer" feel unfinished: the delivery appeared, but sat unrouted
// until someone remembered to re-run the builder.
func TestNewCustomerJoinsTheRoundForTheirArea(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	createArea(t, admin, "Northtown", 12.9800, 77.5946, 3000)

	first := createCustomer(t, admin, "First House", 12.9790, 77.5946)
	createSubscription(t, admin, first, productID, 1)

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	routes, _ := day["routes"].([]any)
	if len(routes) != 1 {
		t.Fatalf("prepared %d rounds, want 1", len(routes))
	}
	roundID := str(routes[0].(map[string]any), "id")

	// Now the admin adds a second customer, mid-morning, and does nothing
	// else at all.
	second := createCustomer(t, admin, "Second House", 12.9810, 77.5946)
	createSubscription(t, admin, second, productID, 3)

	day = admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	summary, _ := day["summary"].(map[string]any)
	if got := num(summary, "unrouted"); got != 0 {
		t.Fatalf("%v deliveries still unrouted after a read, want 0", got)
	}

	onRound := 0
	for _, stop := range stopsOf(t, day) {
		if str(stop, "route_id") == roundID {
			onRound++
		}
	}
	if onRound != 2 {
		t.Fatalf("%d stops on the round, want 2 — the new customer should have been absorbed", onRound)
	}
}

// The driver who ran a round yesterday runs it again today. Re-picking
// the same person every morning is the same daily busywork the Generate
// button was.
func TestPreparedRoundInheritsYesterdaysDriver(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	createArea(t, admin, "Northtown", 12.9800, 77.5946, 3000)
	customer := createCustomer(t, admin, "North House", 12.9810, 77.5946)
	createSubscription(t, admin, customer, productID, 1)

	driver := admin.mustDo(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": "Ravi", "phone": "+91 98765 43210",
	}, http.StatusCreated)
	driverID := str(driver, "id")

	// Today's round, driven by Ravi.
	today := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	todayRoutes, _ := today["routes"].([]any)
	roundID := str(todayRoutes[0].(map[string]any), "id")
	admin.mustDo(http.MethodPost, "/api/v1/routes/"+roundID+"/assign", map[string]any{
		"driver_id": driverID,
	}, http.StatusOK)

	// Tomorrow's round is prepared on read, and Ravi is already on it.
	tomorrow, err := shiftDate(str(today, "date"), 1)
	if err != nil {
		t.Fatalf("shift date: %v", err)
	}
	next := admin.mustDo(http.MethodGet, "/api/v1/day?date="+tomorrow, nil, http.StatusOK)
	nextRoutes, _ := next["routes"].([]any)
	if len(nextRoutes) != 1 {
		t.Fatalf("prepared %d rounds for tomorrow, want 1", len(nextRoutes))
	}
	if got := str(nextRoutes[0].(map[string]any), "driver_id"); got != driverID {
		t.Fatalf("tomorrow's round driver = %q, want %q (yesterday's driver carries forward)", got, driverID)
	}
}

// A past date is a record of what happened, not a template to fill in.
// Reading one must never invent deliveries that were never made.
func TestGetPastDayDoesNotGenerate(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	customer := createCustomer(t, admin, "Anita", 12.9750, 77.5946)
	createSubscription(t, admin, customer, productID, 2)

	day := admin.mustDo(http.MethodGet, "/api/v1/day?date=2020-01-06", nil, http.StatusOK)
	summary, _ := day["summary"].(map[string]any)
	if got := num(summary, "total"); got != 0 {
		t.Fatalf("reading a past day produced %v deliveries, want 0", got)
	}
}

// Two admins opening the same day at the same moment must not each create
// the round neither of them had seen yet. The database settles it (see
// routes_business_date_name_idx); this checks the handler adopts the
// winner's round instead of failing the whole read.
func TestConcurrentReadsPrepareOnlyOneRoundPerArea(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	createArea(t, admin, "Northtown", 12.9800, 77.5946, 3000)
	customer := createCustomer(t, admin, "North House", 12.9810, 77.5946)
	createSubscription(t, admin, customer, productID, 1)

	// Materialize the deliveries but leave the round unprepared, so both
	// reads below race to create it.
	admin.mustDo(http.MethodPost, "/api/v1/day/generate", nil, http.StatusOK)

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
		}()
	}
	wg.Wait()

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	routes, _ := day["routes"].([]any)
	if len(routes) != 1 {
		t.Fatalf("%d rounds after concurrent reads, want exactly 1", len(routes))
	}
}
