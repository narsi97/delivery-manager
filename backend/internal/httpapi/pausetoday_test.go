package httpapi

import (
	"net/http"
	"testing"
)

// A pause set in the morning is a pause for this morning. By then the day
// has already been generated and the driver is counting out the van, so a
// pause that only stopped tomorrow's generation left the household's milk
// in "what today needs" — found in production, on the first real farm.

func customerIDByName(t *testing.T, admin *client, name string) string {
	t.Helper()
	resp := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	list, _ := resp["customers"].([]any)
	for _, item := range list {
		c, _ := item.(map[string]any)
		if str(c, "name") == name {
			return str(c, "id")
		}
	}
	t.Fatalf("no customer called %q", name)
	return ""
}

func loadTotal(t *testing.T, driver *client) (quantity, doors float64) {
	t.Helper()
	today := driver.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)
	for _, line := range loadLines(t, today) {
		quantity += line[0]
		doors += line[1]
	}
	return quantity, doors
}

func TestPausingTakesTodaysDeliveryOffTheLoad(t *testing.T) {
	admin, driver, _ := checkinSetup(t)
	anita := customerIDByName(t, admin, "Anita")

	if q, d := loadTotal(t, driver); q != 4 || d != 2 {
		t.Fatalf("before the pause: load %v across %v doors, want 4 across 2", q, d)
	}

	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+anita, map[string]any{"active": false}, http.StatusOK)
	if q, d := loadTotal(t, driver); q != 2 || d != 1 {
		t.Fatalf("paused this morning: load %v across %v doors, want 2 across 1", q, d)
	}

	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+anita, map[string]any{"active": true}, http.StatusOK)
	if q, d := loadTotal(t, driver); q != 4 || d != 2 {
		t.Fatalf("resumed: load %v across %v doors, want 4 across 2 again", q, d)
	}

	// An away span that covers today does the same.
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+anita, map[string]any{
		"paused_from": dayOffset(0), "paused_until": dayOffset(5),
	}, http.StatusOK)
	if q, d := loadTotal(t, driver); q != 2 || d != 1 {
		t.Fatalf("away from today: load %v across %v doors, want 2 across 1", q, d)
	}
}

// Coming back puts back what the pause took, and nothing else: a day the
// office skipped by hand stays skipped.
func TestResumingLeavesAHandSkipAlone(t *testing.T) {
	admin, driver, _ := checkinSetup(t)
	ravi := customerIDByName(t, admin, "Ravi")

	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	stops, _ := day["stops"].([]any)
	for _, item := range stops {
		stop, _ := item.(map[string]any)
		if str(stop, "customer_id") == ravi {
			admin.mustDo(http.MethodPatch, "/api/v1/orders/"+str(stop, "id"),
				map[string]any{"status": "skipped", "reason": "asked for none today"}, http.StatusOK)
		}
	}

	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+ravi, map[string]any{"active": false}, http.StatusOK)
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+ravi, map[string]any{"active": true}, http.StatusOK)
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	if q, d := loadTotal(t, driver); q != 2 || d != 1 {
		t.Fatalf("after a pause and resume: load %v across %v doors, want 2 across 1 (the hand skip kept)", q, d)
	}
}

// Somebody paused before this fix has a delivery already sitting on
// today's round. The next read of the day tidies it away.
func TestReadingTheDayCatchesAPauseItMissed(t *testing.T) {
	admin, driver, _ := checkinSetup(t)
	anita := customerIDByName(t, admin, "Anita")

	// Pause through the store, the way the old code left things: the
	// customer is paused but today's delivery was never touched.
	server := admin.server
	record := admin.mustDo(http.MethodPatch, "/api/v1/customers/"+anita, map[string]any{}, http.StatusOK)
	c, err := server.store.GetCustomer(t.Context(), str(record, "business_id"), anita)
	if err != nil {
		t.Fatal(err)
	}
	c.Active = false
	if _, err := server.store.UpdateCustomer(t.Context(), c); err != nil {
		t.Fatal(err)
	}
	if q, _ := loadTotal(t, driver); q != 4 {
		t.Fatalf("setup: expected the stale delivery still on the load, got %v", q)
	}

	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	if q, d := loadTotal(t, driver); q != 2 || d != 1 {
		t.Fatalf("after the day was read: load %v across %v doors, want 2 across 1", q, d)
	}
}
