package httpapi

import (
	"net/http"
	"testing"
)

// The pin argument is gone — an owner adds a person, not a credential.
func makeDriver(t *testing.T, admin *client, name, phone string) string {
	t.Helper()
	d := admin.mustDo(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": name, "phone": phone,
	}, http.StatusCreated)
	return str(d, "id")
}

// A route ends when the driver gets home, so assigning one records where
// that is — the route's finish point comes from the driver, not the depot.
func TestAssigningADriverSetsTheRoutesEndPoint(t *testing.T) {
	admin := planSetup(t, 8)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 1}, http.StatusOK)
	routeID := routeIDs(t, day)[0]

	driverID := makeDriver(t, admin, "Ravi", "+91 98765 43210")
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+driverID+"/home",
		map[string]any{"home_lat": 12.9900, "home_lng": 77.6100}, http.StatusOK)

	assigned := admin.mustDo(http.MethodPost, "/api/v1/routes/"+routeID+"/assign",
		map[string]any{"driver_id": driverID}, http.StatusOK)

	if got := num(assigned, "end_lat"); got != 12.9900 {
		t.Fatalf("end_lat = %v, want the driver's home 12.99", got)
	}
	if got := num(assigned, "end_lng"); got != 77.6100 {
		t.Fatalf("end_lng = %v, want the driver's home 77.61", got)
	}
}

// Unassigning takes the finish point away again — the route goes back to
// ending wherever the optimizer leaves it.
func TestUnassigningClearsTheEndPoint(t *testing.T) {
	admin := planSetup(t, 6)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 1}, http.StatusOK)
	routeID := routeIDs(t, day)[0]

	driverID := makeDriver(t, admin, "Ravi", "+91 98765 43210")
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+driverID+"/home",
		map[string]any{"home_lat": 12.9900, "home_lng": 77.6100}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/routes/"+routeID+"/assign",
		map[string]any{"driver_id": driverID}, http.StatusOK)

	cleared := admin.mustDo(http.MethodPost, "/api/v1/routes/"+routeID+"/assign",
		map[string]any{"driver_id": ""}, http.StatusOK)
	if num(cleared, "end_lat") != 0 || num(cleared, "end_lng") != 0 {
		t.Fatalf("end point survived unassignment: %v, %v", num(cleared, "end_lat"), num(cleared, "end_lng"))
	}
}

// The point of all this: where the driver lives changes which stop comes
// last. Two drivers living at opposite ends of the same customer line
// must produce different orders for the same set of stops.
func TestDriversHomeChangesWhichStopIsLast(t *testing.T) {
	lastStopFor := func(t *testing.T, homeLat float64) string {
		t.Helper()
		admin := planSetup(t, 8)
		day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 1}, http.StatusOK)
		routeID := routeIDs(t, day)[0]

		driverID := makeDriver(t, admin, "Ravi", "+91 98765 43210")
		admin.mustDo(http.MethodPost, "/api/v1/drivers/"+driverID+"/home",
			map[string]any{"home_lat": homeLat, "home_lng": 77.5946}, http.StatusOK)
		admin.mustDo(http.MethodPost, "/api/v1/routes/"+routeID+"/assign",
			map[string]any{"driver_id": driverID}, http.StatusOK)

		after := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
		last, highest := "", float64(0)
		for _, stop := range stopsOf(t, after) {
			if str(stop, "route_id") != routeID {
				continue
			}
			if seq := num(stop, "sequence"); seq > highest {
				highest, last = seq, str(stop, "customer_name")
			}
		}
		return last
	}

	// planSetup lays customers north of the depot along one line.
	// A driver living south of it should finish near the depot; one
	// living north should finish at the far end.
	south := lastStopFor(t, 12.9600)
	north := lastStopFor(t, 13.0200)

	if south == "" || north == "" {
		t.Fatal("no last stop found on the route")
	}
	if south == north {
		t.Fatalf("both drivers finish at %q — the driver's home is not affecting the order", south)
	}
}

// Changing a driver's home has to re-order the route they are already on,
// or the change only takes effect the next time someone reassigns them.
func TestChangingDriverHomeReordersTheirCurrentRoute(t *testing.T) {
	admin := planSetup(t, 8)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 1}, http.StatusOK)
	routeID := routeIDs(t, day)[0]

	driverID := makeDriver(t, admin, "Ravi", "+91 98765 43210")
	admin.mustDo(http.MethodPost, "/api/v1/routes/"+routeID+"/assign",
		map[string]any{"driver_id": driverID}, http.StatusOK)

	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+driverID+"/home",
		map[string]any{"home_lat": 13.0200, "home_lng": 77.5946}, http.StatusOK)

	after := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	for _, raw := range after["routes"].([]any) {
		rt := raw.(map[string]any)
		if str(rt, "id") != routeID {
			continue
		}
		if num(rt, "end_lat") != 13.0200 {
			t.Fatalf("route end_lat = %v after the driver moved house, want 13.02", num(rt, "end_lat"))
		}
	}
}

func TestSetDriverHomeRejectsBadCoordinates(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	driverID := makeDriver(t, admin, "Ravi", "+91 98765 43210")

	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+driverID+"/home",
		map[string]any{"home_lat": 200, "home_lng": 77.6}, http.StatusBadRequest)
}
