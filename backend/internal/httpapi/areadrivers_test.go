package httpapi

import (
	"fmt"
	"net/http"
	"testing"
)

// areaSetup builds a business with one service area and n customers
// inside it, and returns the admin client and the area's id.
//
// Customers are laid out as two tight clusters either side of the area
// centre, so a split between two drivers has an obviously right answer
// and a test can tell a real geographic cut from an arbitrary one.
func areaSetup(t *testing.T, perCluster int) (*client, string) {
	t.Helper()
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 12.9700, "home_lng": 77.5946,
	}, http.StatusOK)

	area := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Jayanagar", "lat": 12.9700, "lng": 77.5946, "radius_meters": 8000,
	}, http.StatusCreated)

	for i := 0; i < perCluster; i++ {
		west := createCustomer(t, admin, fmt.Sprintf("West %d", i), 12.9700+float64(i)*0.001, 77.5600)
		createSubscription(t, admin, west, productID, 1)
		east := createCustomer(t, admin, fmt.Sprintf("East %d", i), 12.9700+float64(i)*0.001, 77.6300)
		createSubscription(t, admin, east, productID, 1)
	}

	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	return admin, str(area, "id")
}

func driverWithHome(t *testing.T, admin *client, name, phone string, lat, lng float64) string {
	t.Helper()
	id := makeDriver(t, admin, name, phone)
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+id+"/home",
		map[string]any{"home_lat": lat, "home_lng": lng}, http.StatusOK)
	// These tests are about splitting by where drivers finish, so they
	// opt into finishing at home — the default is the farm, because stock
	// and empties have to come back. See domain.FinishAt.
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+id+"/finish",
		map[string]any{"finish_at": "home"}, http.StatusOK)
	return id
}

func routesOf(t *testing.T, day map[string]any) []map[string]any {
	t.Helper()
	raw, _ := day["routes"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		out = append(out, r.(map[string]any))
	}
	return out
}

// The headline: naming who is driving an area is the whole planning
// interface. Two drivers means two rounds, cut geographically, with no
// count to choose and no form to fill in.
func TestAssigningTwoDriversToAnAreaSplitsIt(t *testing.T) {
	admin, areaID := areaSetup(t, 4)
	west := driverWithHome(t, admin, "Ravi", "+91 90000 00001", 12.9700, 77.5500)
	east := driverWithHome(t, admin, "Kumar", "+91 90000 00002", 12.9700, 77.6400)

	day := admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{west, east}}, http.StatusOK)

	routes := routesOf(t, day)
	if len(routes) != 2 {
		t.Fatalf("assigning 2 drivers produced %d routes, want 2", len(routes))
	}

	assigned := map[string]bool{}
	for _, rt := range routes {
		assigned[str(rt, "driver_id")] = true
	}
	if !assigned[west] || !assigned[east] {
		t.Fatalf("routes went to %v, want one each for %s and %s", assigned, west, east)
	}

	// Every stop stays routed: splitting hands the work out, it never
	// drops any of it.
	onARoute := 0
	for _, stop := range stopsOf(t, day) {
		if str(stop, "route_id") != "" {
			onARoute++
		}
	}
	if onARoute != 8 {
		t.Fatalf("%d of 8 stops are on a route after the split", onARoute)
	}
}

// The point of matching clusters to drivers: the driver who lives west
// gets the western half. Handing them the far cluster would mean a long
// empty drive home, which is real distance now that a round ends at the
// driver's own door.
func TestEachDriverGetsTheClusterNearestTheirHome(t *testing.T) {
	admin, areaID := areaSetup(t, 4)
	west := driverWithHome(t, admin, "Ravi", "+91 90000 00001", 12.9700, 77.5500)
	east := driverWithHome(t, admin, "Kumar", "+91 90000 00002", 12.9700, 77.6400)

	day := admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{west, east}}, http.StatusOK)

	routeOfDriver := map[string]string{}
	for _, rt := range routesOf(t, day) {
		routeOfDriver[str(rt, "driver_id")] = str(rt, "id")
	}

	for _, stop := range stopsOf(t, day) {
		name := str(stop, "customer_name")
		wantDriver := west
		if name[:4] == "East" {
			wantDriver = east
		}
		if got := str(stop, "route_id"); got != routeOfDriver[wantDriver] {
			t.Fatalf("%s landed on route %s, want the one for the nearer driver (%s)",
				name, got, routeOfDriver[wantDriver])
		}
	}
}

// Each split round finishes at its own driver's home, which is what makes
// the ordering worth anything — see route.OptimizeReturning.
func TestSplitRoundsEndAtTheirOwnDriversHome(t *testing.T) {
	admin, areaID := areaSetup(t, 3)
	west := driverWithHome(t, admin, "Ravi", "+91 90000 00001", 12.9700, 77.5500)
	east := driverWithHome(t, admin, "Kumar", "+91 90000 00002", 12.9700, 77.6400)

	day := admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{west, east}}, http.StatusOK)

	wantLng := map[string]float64{west: 77.5500, east: 77.6400}
	for _, rt := range routesOf(t, day) {
		driverID := str(rt, "driver_id")
		if got := num(rt, "end_lng"); got != wantLng[driverID] {
			t.Fatalf("route for driver %s ends at lng %v, want their home %v",
				driverID, got, wantLng[driverID])
		}
	}
}

// One driver has to behave exactly as it always did — a single round for
// the area, keeping the plain area name. The one-van dairy is the common
// case and must not notice this feature exists.
func TestAssigningOneDriverKeepsASingleRound(t *testing.T) {
	admin, areaID := areaSetup(t, 4)
	solo := driverWithHome(t, admin, "Ravi", "+91 90000 00001", 12.9700, 77.5500)

	day := admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{solo}}, http.StatusOK)

	routes := routesOf(t, day)
	if len(routes) != 1 {
		t.Fatalf("one driver produced %d routes, want 1", len(routes))
	}
	if got := str(routes[0], "name"); got != "Jayanagar route" {
		t.Fatalf("single-driver route is named %q, want %q", got, "Jayanagar route")
	}
	if got := str(routes[0], "driver_id"); got != solo {
		t.Fatalf("route driver = %q, want %q", got, solo)
	}
}

// Un-assigning everyone returns the area to the state it would have
// derived on its own: one unassigned round, still holding the work.
// Emptying the driver list must not delete the day off the map.
func TestClearingDriversReturnsToOneUnassignedRound(t *testing.T) {
	admin, areaID := areaSetup(t, 3)
	west := driverWithHome(t, admin, "Ravi", "+91 90000 00001", 12.9700, 77.5500)
	east := driverWithHome(t, admin, "Kumar", "+91 90000 00002", 12.9700, 77.6400)

	admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{west, east}}, http.StatusOK)

	day := admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{}}, http.StatusOK)

	routes := routesOf(t, day)
	if len(routes) != 1 {
		t.Fatalf("clearing drivers left %d routes, want 1", len(routes))
	}
	if got := str(routes[0], "driver_id"); got != "" {
		t.Fatalf("route still assigned to %q after clearing drivers", got)
	}
	routed := 0
	for _, stop := range stopsOf(t, day) {
		if str(stop, "route_id") != "" {
			routed++
		}
	}
	if routed != 6 {
		t.Fatalf("%d of 6 stops still routed after clearing drivers, want all of them", routed)
	}
}

// Re-assigning the same drivers must produce the same split. An admin who
// changes nothing and presses again cannot be shown a reshuffle — that is
// what route.Partition's determinism and AssignToFinishes's index
// tie-breaks are for.
func TestReassigningTheSameDriversIsStable(t *testing.T) {
	admin, areaID := areaSetup(t, 4)
	west := driverWithHome(t, admin, "Ravi", "+91 90000 00001", 12.9700, 77.5500)
	east := driverWithHome(t, admin, "Kumar", "+91 90000 00002", 12.9700, 77.6400)

	shape := func(day map[string]any) map[string]string {
		routeDriver := map[string]string{}
		for _, rt := range routesOf(t, day) {
			routeDriver[str(rt, "id")] = str(rt, "driver_id")
		}
		out := map[string]string{}
		for _, stop := range stopsOf(t, day) {
			out[str(stop, "customer_name")] = routeDriver[str(stop, "route_id")]
		}
		return out
	}

	first := shape(admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{west, east}}, http.StatusOK))
	second := shape(admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{west, east}}, http.StatusOK))

	for customer, driver := range first {
		if second[customer] != driver {
			t.Fatalf("%s moved from driver %s to %s on an identical re-assign",
				customer, driver, second[customer])
		}
	}
}

// A driver who is not a driver, or whose account is off, is refused
// before anything is written — the area keeps the plan it had.
func TestAssigningARejectedDriverLeavesThePlanAlone(t *testing.T) {
	admin, areaID := areaSetup(t, 3)
	good := driverWithHome(t, admin, "Ravi", "+91 90000 00001", 12.9700, 77.5500)
	gone := makeDriver(t, admin, "Kumar", "+91 90000 00002")
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+gone+"/active",
		map[string]any{"active": false}, http.StatusOK)

	admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{good}}, http.StatusOK)

	admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{good, gone}}, http.StatusBadRequest)

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	routes := routesOf(t, day)
	if len(routes) != 1 {
		t.Fatalf("a rejected assignment changed the plan: %d routes, want the previous 1", len(routes))
	}
	if got := str(routes[0], "driver_id"); got != good {
		t.Fatalf("route driver = %q after a rejected assignment, want the previous %q", got, good)
	}
}

// One area being split must not disturb another. This is the whole reason
// it is scoped to an area rather than re-cutting the day the way
// /routes/plan does.
func TestSplittingOneAreaLeavesTheOtherAlone(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 12.9700, "home_lng": 77.5946,
	}, http.StatusOK)

	near := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Jayanagar", "lat": 12.9700, "lng": 77.5946, "radius_meters": 5000,
	}, http.StatusCreated)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Kodad", "lat": 16.9900, "lng": 79.9600, "radius_meters": 5000,
	}, http.StatusCreated)

	for i := 0; i < 3; i++ {
		a := createCustomer(t, admin, fmt.Sprintf("Jaya %d", i), 12.9700+float64(i)*0.002, 77.5900)
		createSubscription(t, admin, a, productID, 1)
		b := createCustomer(t, admin, fmt.Sprintf("Kodad %d", i), 16.9900+float64(i)*0.002, 79.9600)
		createSubscription(t, admin, b, productID, 1)
	}
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	west := driverWithHome(t, admin, "Ravi", "+91 90000 00001", 12.9700, 77.5500)
	east := driverWithHome(t, admin, "Kumar", "+91 90000 00002", 12.9700, 77.6400)

	day := admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+str(near, "id")+"/drivers",
		map[string]any{"driver_ids": []string{west, east}}, http.StatusOK)

	kodad := 0
	for _, rt := range routesOf(t, day) {
		if str(rt, "name") == "Kodad route" {
			kodad++
		}
	}
	if kodad != 1 {
		t.Fatalf("Kodad has %d routes after splitting Jayanagar, want its original 1", kodad)
	}
}

// The split has to survive the night, or it is worth nothing: an admin
// who shares Jayanagar between two drivers today must not have to say so
// again tomorrow morning. Same reasoning as carrying a single driver
// forward, applied to the whole crew.
func TestAMultiDriverSplitCarriesForwardToTomorrow(t *testing.T) {
	admin, areaID := areaSetup(t, 4)
	west := driverWithHome(t, admin, "Ravi", "+91 90000 00001", 12.9700, 77.5500)
	east := driverWithHome(t, admin, "Kumar", "+91 90000 00002", 12.9700, 77.6400)

	today := admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{west, east}}, http.StatusOK)

	tomorrow, err := shiftDate(str(today, "date"), 1)
	if err != nil {
		t.Fatalf("shift date: %v", err)
	}
	next := admin.mustDo(http.MethodGet, "/api/v1/day?date="+tomorrow, nil, http.StatusOK)

	routes := routesOf(t, next)
	if len(routes) != 2 {
		t.Fatalf("prepared %d rounds for tomorrow, want the same 2 the split produced", len(routes))
	}
	drivers := map[string]bool{}
	for _, rt := range routes {
		drivers[str(rt, "driver_id")] = true
	}
	if !drivers[west] || !drivers[east] {
		t.Fatalf("tomorrow's rounds went to %v, want both %s and %s", drivers, west, east)
	}

	// And every one of tomorrow's stops is on one of them.
	for _, stop := range stopsOf(t, next) {
		if str(stop, "route_id") == "" {
			t.Fatalf("%s is unrouted tomorrow — the carried-forward split left work behind",
				str(stop, "customer_name"))
		}
	}
}

// A driver deactivated overnight must not be carried into tomorrow's
// split. The area falls back to the drivers who are actually available.
func TestADeactivatedDriverIsNotCarriedForward(t *testing.T) {
	admin, areaID := areaSetup(t, 4)
	west := driverWithHome(t, admin, "Ravi", "+91 90000 00001", 12.9700, 77.5500)
	east := driverWithHome(t, admin, "Kumar", "+91 90000 00002", 12.9700, 77.6400)

	today := admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{west, east}}, http.StatusOK)

	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+east+"/active",
		map[string]any{"active": false}, http.StatusOK)

	tomorrow, err := shiftDate(str(today, "date"), 1)
	if err != nil {
		t.Fatalf("shift date: %v", err)
	}
	next := admin.mustDo(http.MethodGet, "/api/v1/day?date="+tomorrow, nil, http.StatusOK)

	routes := routesOf(t, next)
	if len(routes) != 1 {
		t.Fatalf("prepared %d rounds for tomorrow, want 1 — only one driver is still active", len(routes))
	}
	if got := str(routes[0], "driver_id"); got != west {
		t.Fatalf("tomorrow's round driver = %q, want the still-active %q", got, west)
	}
	for _, stop := range stopsOf(t, next) {
		if str(stop, "route_id") == "" {
			t.Fatalf("%s is unrouted after a driver was deactivated", str(stop, "customer_name"))
		}
	}
}

// The case a real dairy described: the owner does ten on the way through
// and the full-time driver takes the rest.
func TestADriverCanBeCappedAtSoManyStops(t *testing.T) {
	admin, areaID := areaSetup(t, 10) // 20 customers, two clusters
	owner := driverWithHome(t, admin, "Owner", "+91 90000 00001", 12.9700, 77.5500)
	fullTime := driverWithHome(t, admin, "Ravi", "+91 90000 00002", 12.9700, 77.6400)

	day := admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers", map[string]any{
		"driver_ids":     []string{owner, fullTime},
		"max_per_driver": map[string]any{owner: 6},
	}, http.StatusOK)

	counts := map[string]int{}
	routeDriver := map[string]string{}
	for _, rt := range routesOf(t, day) {
		routeDriver[str(rt, "id")] = str(rt, "driver_id")
	}
	for _, stop := range stopsOf(t, day) {
		if rid := str(stop, "route_id"); rid != "" {
			counts[routeDriver[rid]]++
		}
	}

	if counts[owner] != 6 {
		t.Fatalf("the capped owner got %d stops, want exactly 6", counts[owner])
	}
	if counts[fullTime] != 14 {
		t.Fatalf("the uncapped driver got %d stops, want the remaining 14", counts[fullTime])
	}
}

// Caps that don't cover the day leave the shortfall unassigned and
// visible, rather than quietly overloading somebody.
func TestWorkBeyondEveryCapStaysUnassigned(t *testing.T) {
	admin, areaID := areaSetup(t, 10) // 20 customers
	a := driverWithHome(t, admin, "A", "+91 90000 00001", 12.9700, 77.5500)
	b := driverWithHome(t, admin, "B", "+91 90000 00002", 12.9700, 77.6400)

	day := admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers", map[string]any{
		"driver_ids":     []string{a, b},
		"max_per_driver": map[string]any{a: 4, b: 4},
	}, http.StatusOK)

	routed, unrouted := 0, 0
	for _, stop := range stopsOf(t, day) {
		if str(stop, "route_id") == "" {
			unrouted++
		} else {
			routed++
		}
	}
	if routed != 8 {
		t.Fatalf("%d stops routed, want 8 — the caps must hold", routed)
	}
	if unrouted != 12 {
		t.Fatalf("%d stops unassigned, want 12 left visible for the admin to deal with", unrouted)
	}
}

// A single named driver with a cap takes only that many.
func TestOneCappedDriverLeavesTheRest(t *testing.T) {
	admin, areaID := areaSetup(t, 5) // 10 customers
	solo := driverWithHome(t, admin, "Solo", "+91 90000 00001", 12.9700, 77.5500)

	day := admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers", map[string]any{
		"driver_ids":     []string{solo},
		"max_per_driver": map[string]any{solo: 3},
	}, http.StatusOK)

	routed := 0
	for _, stop := range stopsOf(t, day) {
		if str(stop, "route_id") != "" {
			routed++
		}
	}
	if routed != 3 {
		t.Fatalf("%d stops routed, want 3", routed)
	}
}

// routedCount is what any screen would see after a plain read of the day
// — the check that matters, because rounds re-prepare themselves on every
// read and a limit that only holds in the reply to the request that set
// it holds for about one second.
func routedCount(t *testing.T, admin *client) int {
	t.Helper()
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	n := 0
	for _, stop := range stopsOf(t, day) {
		if str(stop, "route_id") != "" {
			n++
		}
	}
	return n
}

// The bug this exists to stop: capping a driver worked, and then the very
// next page load handed them back every stop the admin had just taken
// off them. A cap is a property of the van, so it has to survive.
func TestACapSurvivesTheNextReadOfTheDay(t *testing.T) {
	admin, areaID := areaSetup(t, 5) // 10 customers
	solo := driverWithHome(t, admin, "Solo", "+91 90000 00001", 12.9700, 77.5500)

	admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers", map[string]any{
		"driver_ids":     []string{solo},
		"max_per_driver": map[string]any{solo: 3},
	}, http.StatusOK)

	for i := 0; i < 3; i++ {
		if routed := routedCount(t, admin); routed != 3 {
			t.Fatalf("read %d of the day shows %d routed stops, want 3 — the cap was forgotten", i+1, routed)
		}
	}
}

// The same, for a split: neither driver quietly grows past their van
// overnight, and the shortfall stays visible.
func TestCapsHoldAcrossReadsForASplitArea(t *testing.T) {
	admin, areaID := areaSetup(t, 10) // 20 customers
	a := driverWithHome(t, admin, "A", "+91 90000 00001", 12.9700, 77.5500)
	b := driverWithHome(t, admin, "B", "+91 90000 00002", 12.9700, 77.6400)

	admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers", map[string]any{
		"driver_ids":     []string{a, b},
		"max_per_driver": map[string]any{a: 4, b: 4},
	}, http.StatusOK)

	if routed := routedCount(t, admin); routed != 8 {
		t.Fatalf("after a re-read %d stops are routed, want 8", routed)
	}
}

// Lowering a limit takes work off a driver who is already loaded, without
// the admin having to re-assign anybody.
func TestLoweringADriversLimitTrimsTheirRound(t *testing.T) {
	admin, areaID := areaSetup(t, 5) // 10 customers
	solo := driverWithHome(t, admin, "Solo", "+91 90000 00001", 12.9700, 77.5500)

	admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers",
		map[string]any{"driver_ids": []string{solo}}, http.StatusOK)
	if routed := routedCount(t, admin); routed != 10 {
		t.Fatalf("an uncapped driver has %d stops, want all 10", routed)
	}

	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+solo+"/max-stops",
		map[string]any{"max_stops": 4}, http.StatusOK)
	if routed := routedCount(t, admin); routed != 4 {
		t.Fatalf("after lowering the limit to 4, %d stops are routed", routed)
	}

	// And raising it again gives the work back.
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+solo+"/max-stops",
		map[string]any{"max_stops": 0}, http.StatusOK)
	if routed := routedCount(t, admin); routed != 10 {
		t.Fatalf("after clearing the limit, %d stops are routed, want all 10 back", routed)
	}
}

// A shop that has to be first is not the stop a cap drops. Priority
// decides who gets carried; the limit only decides how many.
func TestACapKeepsThePriorityCustomers(t *testing.T) {
	admin, areaID := areaSetup(t, 5) // 10 ordinary customers
	productID := firstProductID(t, admin)
	shop := createCustomer(t, admin, "Corner Shop", 12.9700, 77.6300)
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+shop,
		map[string]any{"priority": "business"}, http.StatusOK)
	createSubscription(t, admin, shop, productID, 1)

	solo := driverWithHome(t, admin, "Solo", "+91 90000 00001", 12.9700, 77.5500)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas/"+areaID+"/drivers", map[string]any{
		"driver_ids":     []string{solo},
		"max_per_driver": map[string]any{solo: 2},
	}, http.StatusOK)

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	kept := false
	for _, stop := range stopsOf(t, day) {
		if str(stop, "customer_name") == "Corner Shop" && str(stop, "route_id") != "" {
			kept = true
		}
	}
	if !kept {
		t.Fatal("the cap dropped the shop, which is the one stop that cannot be dropped")
	}
}
