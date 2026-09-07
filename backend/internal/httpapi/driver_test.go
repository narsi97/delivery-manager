package httpapi

import (
	"net/http"
	"testing"
)

// A number somebody leans on the keyboard for used to reach the
// database, overflow a 32-bit column and come back as "something went
// wrong" — a 500 for a typo. A van is not a fleet.
func TestDriverLimitIsCappedRatherThanCrashing(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	driver := admin.mustDo(http.MethodPost, "/api/v1/drivers",
		map[string]any{"name": "Chandu", "phone": "7995783107"}, http.StatusCreated)
	id := str(driver, "id")

	body := admin.mustDo(http.MethodPost, "/api/v1/drivers/"+id+"/max-stops",
		map[string]any{"max_stops": 9000000000}, http.StatusBadRequest)
	if code := str(body, "code"); code != "invalid_max_stops" {
		t.Errorf("code = %q, want invalid_max_stops", code)
	}

	// The ceiling itself is fine, and so is none at all.
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+id+"/max-stops",
		map[string]any{"max_stops": 100}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+id+"/max-stops",
		map[string]any{"max_stops": 0}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+id+"/max-stops",
		map[string]any{"max_stops": 101}, http.StatusBadRequest)
}
