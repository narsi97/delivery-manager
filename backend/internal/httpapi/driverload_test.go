package httpapi

import (
	"net/http"
	"testing"
)

func loadLines(t *testing.T, body map[string]any) map[string][2]float64 {
	t.Helper()
	raw, _ := body["load"].([]any)
	out := map[string][2]float64{}
	for _, item := range raw {
		line, _ := item.(map[string]any)
		out[str(line, "name")] = [2]float64{num(line, "quantity"), num(line, "doors")}
	}
	return out
}

// Filling the van is what the driver is doing at the moment they ask for
// approval, and the stop list is still behind the gate. Asking somebody
// to count out bottles for a round they cannot see is asking them to
// guess.
func TestDriverSeesWhatToLoadBeforeApproval(t *testing.T) {
	_, driver, _ := checkinSetup(t)

	locked := driver.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)
	if stops, _ := locked["stops"].([]any); len(stops) != 0 {
		t.Fatalf("stops should still be hidden before approval, got %d", len(stops))
	}

	lines := loadLines(t, locked)
	if len(lines) == 0 {
		t.Fatal("the driver was told nothing about what to load")
	}
	// checkinSetup puts two customers on two of the same product.
	for name, got := range lines {
		if got[0] != 4 {
			t.Errorf("%s: quantity %v, want 4 (two doors at two each)", name, got[0])
		}
		if got[1] != 2 {
			t.Errorf("%s: doors %v, want 2", name, got[1])
		}
	}
}

// The same totals are still there once the round opens, so the driver
// can check the crate against them at any point.
func TestLoadSurvivesApproval(t *testing.T) {
	admin, driver, driverID := checkinSetup(t)
	driver.mustDo(http.MethodPost, "/api/v1/driver/checkin", map[string]any{"units": 4}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/checkins/"+driverID+"/review",
		map[string]any{"approve": true}, http.StatusOK)

	open := driver.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)
	if stops, _ := open["stops"].([]any); len(stops) == 0 {
		t.Fatal("stops should be visible after approval")
	}
	if len(loadLines(t, open)) == 0 {
		t.Error("the load list disappeared once the round opened")
	}
}
