package httpapi

import (
	"net/http"
	"testing"

	"delivery-manager/internal/domain"
)

// checkinSetup builds a business with one route assigned to one driver,
// and returns the admin, the driver's session, and the driver's id.
func checkinSetup(t *testing.T) (*client, *client, string) {
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
	for i, name := range []string{"Anita", "Ravi"} {
		id := createCustomer(t, admin, name, 17.0510+float64(i)*0.003, 79.2670)
		createSubscription(t, admin, id, productID, 2)
	}

	driverID := makeDriver(t, admin, "Kumar", "+919876543210")
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/routes/"+routeIDs(t, day)[0]+"/assign",
		map[string]any{"driver_id": driverID}, http.StatusOK)

	return admin, signInWithOTP(t, server, "+919876543210", nil), driverID
}

// The whole point: a van does not leave until somebody at the farm has
// agreed what is on it.
func TestStopsAreHiddenUntilTheCountIsApproved(t *testing.T) {
	admin, driver, driverID := checkinSetup(t)

	locked := driver.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)
	if stops, _ := locked["stops"].([]any); len(stops) != 0 {
		t.Fatalf("driver saw %d stops before checking in", len(stops))
	}
	if !locked["checkin_required"].(bool) {
		t.Fatal("the app was not told to ask for a check-in")
	}

	// Reporting alone is not enough — it has to be agreed.
	driver.mustDo(http.MethodPost, "/api/v1/driver/checkin", map[string]any{"units": 40}, http.StatusOK)
	stillLocked := driver.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)
	if stops, _ := stillLocked["stops"].([]any); len(stops) != 0 {
		t.Fatalf("driver saw %d stops while still waiting for approval", len(stops))
	}

	admin.mustDo(http.MethodPost, "/api/v1/checkins/"+driverID+"/review",
		map[string]any{"approve": true}, http.StatusOK)

	unlocked := driver.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)
	stops, _ := unlocked["stops"].([]any)
	if len(stops) != 2 {
		t.Fatalf("driver saw %d stops after approval, want 2", len(stops))
	}
	if unlocked["checkin_required"].(bool) {
		t.Fatal("the app is still being told to ask for a check-in after approval")
	}
}

// A rejection is a correction, not a lockout: the driver counts again.
func TestARejectedCountCanBeReportedAgain(t *testing.T) {
	admin, driver, driverID := checkinSetup(t)

	driver.mustDo(http.MethodPost, "/api/v1/driver/checkin", map[string]any{"units": 12}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/checkins/"+driverID+"/review",
		map[string]any{"approve": false, "note": "that's 12 short — recount"}, http.StatusOK)

	rejected := driver.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)
	checkin, _ := rejected["checkin"].(map[string]any)
	if got := str(checkin, "status"); got != string(domain.CheckinRejected) {
		t.Fatalf("check-in status = %q, want rejected", got)
	}
	if got := str(checkin, "review_note"); got == "" {
		t.Fatal("the driver was rejected without being told why")
	}

	// Count again, get approved, get the round.
	driver.mustDo(http.MethodPost, "/api/v1/driver/checkin", map[string]any{"units": 24}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/checkins/"+driverID+"/review",
		map[string]any{"approve": true}, http.StatusOK)
	unlocked := driver.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)
	if stops, _ := unlocked["stops"].([]any); len(stops) != 2 {
		t.Fatalf("driver saw %d stops after recounting, want 2", len(stops))
	}
}

// Rejecting without saying why is refused. "12 short" is something a
// driver standing at the farm can act on; a bare no is not.
func TestRejectingNeedsAReason(t *testing.T) {
	admin, driver, driverID := checkinSetup(t)
	driver.mustDo(http.MethodPost, "/api/v1/driver/checkin", map[string]any{"units": 12}, http.StatusOK)

	rec, _ := admin.do(http.MethodPost, "/api/v1/checkins/"+driverID+"/review",
		map[string]any{"approve": false})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("rejecting with no reason = %d, want 400", rec.Code)
	}
}

// Reporting again replaces the previous attempt. An admin should never
// be looking at two counts from one driver for one morning.
func TestReportingAgainReplacesTheEarlierCount(t *testing.T) {
	admin, driver, _ := checkinSetup(t)

	driver.mustDo(http.MethodPost, "/api/v1/driver/checkin", map[string]any{"units": 10}, http.StatusOK)
	driver.mustDo(http.MethodPost, "/api/v1/driver/checkin", map[string]any{"units": 24}, http.StatusOK)

	queue := admin.mustDo(http.MethodGet, "/api/v1/checkins", nil, http.StatusOK)
	list, _ := queue["checkins"].([]any)
	if len(list) != 1 {
		t.Fatalf("%d check-ins queued for one driver, want 1", len(list))
	}
	if got := num(list[0].(map[string]any), "units"); got != 24 {
		t.Fatalf("queued count is %v, want the corrected 24", got)
	}
}

// Once agreed, the count is settled — quietly revising it afterwards
// would make the approval meaningless.
func TestAnApprovedCountCannotBeRevised(t *testing.T) {
	admin, driver, driverID := checkinSetup(t)
	driver.mustDo(http.MethodPost, "/api/v1/driver/checkin", map[string]any{"units": 24}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/checkins/"+driverID+"/review",
		map[string]any{"approve": true}, http.StatusOK)

	rec, _ := driver.do(http.MethodPost, "/api/v1/driver/checkin", map[string]any{"units": 40})
	if rec.Code != http.StatusConflict {
		t.Fatalf("revising an approved count = %d, want 409", rec.Code)
	}
}

// A count of nothing is not a count.
func TestCheckinNeedsAPositiveCount(t *testing.T) {
	_, driver, _ := checkinSetup(t)
	for _, units := range []int{0, -5} {
		rec, _ := driver.do(http.MethodPost, "/api/v1/driver/checkin", map[string]any{"units": units})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("units=%d = %d, want 400", units, rec.Code)
		}
	}
}

// A driver with no round assigned is told that plainly, rather than
// being asked to count stock for a round that doesn't exist.
func TestNoRouteMeansNoCheckinPrompt(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	makeDriver(t, admin, "Idle", "+919000000077")
	idle := signInWithOTP(t, server, "+919000000077", nil)

	today := idle.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)
	if today["checkin_required"].(bool) {
		t.Fatal("a driver with no round was asked to check in")
	}
}
