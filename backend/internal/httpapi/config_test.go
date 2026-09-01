package httpapi

import (
	"net/http"
	"testing"
)

// adminForVertical signs in as the local dev admin of a business of the
// given type, so a test can exercise a vertical other than the default
// dairy without needing a Google identity.
func adminForVertical(t *testing.T, s *Server, businessType string) *client {
	t.Helper()
	c := &client{t: t, server: s}
	resp := c.mustDo(http.MethodPost, "/api/v1/auth/dev-login", map[string]any{"business_type": businessType}, http.StatusOK)
	c.token = str(resp, "token")
	if c.token == "" {
		t.Fatal("dev-login returned no token")
	}
	return c
}

func configOf(t *testing.T, c *client) map[string]any {
	t.Helper()
	resp := c.mustDo(http.MethodGet, "/api/v1/config", nil, http.StatusOK)
	config, _ := resp["config"].(map[string]any)
	if config == nil {
		t.Fatal("config response had no config")
	}
	return config
}

// The load-bearing claim of the whole configuration layer: a school runs
// on the same engine as a dairy, with different vocabulary, different
// required information and a different doorstep ritual, and not one line
// of the delivery code knows the difference.
func TestSchoolVerticalRunsOnTheSameEngine(t *testing.T) {
	server := newTestServer(t)
	admin := adminForVertical(t, server, "school")

	config := configOf(t, admin)
	terminology, _ := config["terminology"].(map[string]any)
	if str(terminology, "customer") != "Student" {
		t.Fatalf("a school calls its customers %q, want Student", str(terminology, "customer"))
	}

	productID := firstProductID(t, admin)

	// The school preset requires a guardian name and phone. A student
	// created without them must be refused — that is the config
	// enforcing a vertical's rules, not a hardcoded school branch.
	rec, _ := admin.do(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Meera", "lat": 12.98, "lng": 77.59,
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("student without a guardian = %d, want 400", rec.Code)
	}

	student := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Meera",
		"lat":  12.98,
		"lng":  77.59,
		"custom_fields": map[string]any{
			"class":          "4B",
			"guardian_name":  "Anita",
			"guardian_phone": "+91 98765 43211",
		},
	}, http.StatusCreated)

	stored, _ := student["custom_fields"].(map[string]any)
	if str(stored, "class") != "4B" {
		t.Fatalf("stored custom fields = %+v", stored)
	}
	if str(stored, "guardian_phone") != "9876543211" {
		t.Errorf("guardian phone was not normalized: %v", stored["guardian_phone"])
	}

	createSubscription(t, admin, str(student, "id"), productID, 1)
	driver := admin.mustDo(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": "Ravi", "phone": "+919876543210",
	}, http.StatusCreated)

	admin.mustDo(http.MethodPost, "/api/v1/day/generate", nil, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/routes", map[string]any{
		"start_lat": 12.97, "start_lng": 77.59, "driver_id": str(driver, "id"),
	}, http.StatusOK)

	driverSession := signInWithOTP(t, server, "+919876543210", nil)
	checkInAndApprove(t, admin, driverSession, str(driver, "id"), 1)

	today := driverSession.mustDo(http.MethodGet, "/api/v1/driver/today", nil, http.StatusOK)

	// The driver gets the capture specs in the same payload as the round.
	captures, _ := today["captures"].([]any)
	if len(captures) == 0 {
		t.Fatal("driver's round arrived without the capture specs it needs to close a stop")
	}

	stops := stopsOf(t, today)
	if len(stops) != 1 {
		t.Fatalf("driver has %d stops, want 1", len(stops))
	}
	// The guardian's phone travels to the door, so the driver can call
	// without a second request on a bad connection.
	customerFields, _ := stops[0]["customer_fields"].(map[string]any)
	if str(customerFields, "guardian_phone") != "9876543211" {
		t.Fatalf("stop is missing the guardian phone: %+v", customerFields)
	}

	stopID := str(stops[0], "id")

	// "Handed to" is required on a completed drop.
	rec, _ = driverSession.do(http.MethodPost, "/api/v1/driver/stops/"+stopID+"/status", map[string]any{
		"status": "delivered",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("closing a school drop without 'handed to' = %d, want 400", rec.Code)
	}

	completed := driverSession.mustDo(http.MethodPost, "/api/v1/driver/stops/"+stopID+"/status", map[string]any{
		"status":   "delivered",
		"captures": map[string]any{"handed_to": "Anita (mother)"},
	}, http.StatusOK)

	recorded, _ := completed["captures"].(map[string]any)
	if str(recorded, "handed_to") != "Anita (mother)" {
		t.Fatalf("capture was not recorded: %+v", recorded)
	}

	// And the office can see what was captured.
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	adminView, _ := stopsOf(t, day)[0]["captures"].(map[string]any)
	if str(adminView, "handed_to") != "Anita (mother)" {
		t.Fatalf("admin can't see the driver's capture: %+v", adminView)
	}
}

// A dairy must not inherit any of the school's ceremony — the simple case
// stays simple.
func TestDairyStopClosesWithNoCaptures(t *testing.T) {
	server := newTestServer(t)
	admin := adminForVertical(t, server, "dairy")
	productID := firstProductID(t, admin)

	customer := createCustomer(t, admin, "Regular", 12.98, 77.59)
	createSubscription(t, admin, customer, productID, 2)
	driver := admin.mustDo(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": "Ravi", "phone": "+919876543210",
	}, http.StatusCreated)

	admin.mustDo(http.MethodPost, "/api/v1/day/generate", nil, http.StatusOK)
	built := admin.mustDo(http.MethodPost, "/api/v1/routes", map[string]any{
		"start_lat": 12.97, "start_lng": 77.59, "driver_id": str(driver, "id"),
	}, http.StatusOK)

	driverSession := signInWithOTP(t, server, "+919876543210", nil)

	driverSession.mustDo(http.MethodPost, "/api/v1/driver/stops/"+str(stopsOf(t, built)[0], "id")+"/status",
		map[string]any{"status": "delivered"}, http.StatusOK)
}

// Adding a field is a config edit, not a migration — that is the whole
// point of the layer.
func TestAdminCanDeclareAndUseANewCustomField(t *testing.T) {
	server := newTestServer(t)
	admin := adminForVertical(t, server, "dairy")

	// Before declaring it, the key must be refused.
	rec, _ := admin.do(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Anita", "custom_fields": map[string]any{"gate_code": "1234"},
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("undeclared custom field = %d, want 400", rec.Code)
	}

	admin.mustDo(http.MethodPut, "/api/v1/config", map[string]any{
		"config": map[string]any{
			"custom_fields": []any{
				map[string]any{"key": "gate_code", "label": "Gate code", "type": "text", "applies_to": "customer"},
			},
		},
	}, http.StatusOK)

	created := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Anita", "custom_fields": map[string]any{"gate_code": "1234"},
	}, http.StatusCreated)
	stored, _ := created["custom_fields"].(map[string]any)
	if str(stored, "gate_code") != "1234" {
		t.Fatalf("declared field wasn't stored: %+v", stored)
	}
}

// Removing a declaration stops new writes but must not destroy values
// already recorded — an invoice or a dispute may depend on them.
func TestRemovingAFieldKeepsAlreadyRecordedValues(t *testing.T) {
	server := newTestServer(t)
	admin := adminForVertical(t, server, "dairy")

	admin.mustDo(http.MethodPut, "/api/v1/config", map[string]any{
		"config": map[string]any{
			"custom_fields": []any{
				map[string]any{"key": "gate_code", "label": "Gate code", "type": "text", "applies_to": "customer"},
			},
		},
	}, http.StatusOK)

	admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Anita", "custom_fields": map[string]any{"gate_code": "1234"},
	}, http.StatusCreated)

	admin.mustDo(http.MethodPut, "/api/v1/config", map[string]any{
		"config": map[string]any{"custom_fields": []any{}},
	}, http.StatusOK)

	listed := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	customers, _ := listed["customers"].([]any)
	found, _ := customers[0].(map[string]any)
	stored, _ := found["custom_fields"].(map[string]any)
	if str(stored, "gate_code") != "1234" {
		t.Fatalf("removing the declaration destroyed the recorded value: %+v", found)
	}

	// New writes with the now-undeclared key are refused.
	rec, _ := admin.do(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Bhavna", "custom_fields": map[string]any{"gate_code": "9999"},
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("write to an undeclared field = %d, want 400", rec.Code)
	}
}

func TestInvalidConfigIsRejected(t *testing.T) {
	server := newTestServer(t)
	admin := adminForVertical(t, server, "dairy")

	cases := map[string]any{
		"key with spaces": map[string]any{
			"custom_fields": []any{map[string]any{"key": "gate code", "type": "text", "applies_to": "customer"}},
		},
		"unknown type": map[string]any{
			"custom_fields": []any{map[string]any{"key": "birthday", "type": "date", "applies_to": "customer"}},
		},
		"capture on an impossible outcome": map[string]any{
			"stop_captures": []any{map[string]any{"key": "note", "type": "text", "on_status": []string{"pending"}}},
		},
	}

	for name, config := range cases {
		t.Run(name, func(t *testing.T) {
			rec, decoded := admin.do(http.MethodPut, "/api/v1/config", map[string]any{"config": config})
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("= %d, want 400", rec.Code)
			}
			if str(decoded, "code") != "invalid_config" {
				t.Fatalf("error code = %q, want invalid_config", str(decoded, "code"))
			}
		})
	}
}

// A driver needs the config to know what to ask for at the door, but must
// not be able to change it.
func TestDriverCanReadConfigButNotChangeIt(t *testing.T) {
	server := newTestServer(t)
	admin := adminForVertical(t, server, "school")
	admin.mustDo(http.MethodPost, "/api/v1/drivers", map[string]any{
		"name": "Ravi", "phone": "+919876543210",
	}, http.StatusCreated)

	driverSession := signInWithOTP(t, server, "+919876543210", nil)

	config := configOf(t, driverSession)
	if config["stop_captures"] == nil {
		t.Fatal("driver's config response has no capture specs")
	}

	rec, _ := driverSession.do(http.MethodPut, "/api/v1/config", map[string]any{"config": map[string]any{}})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("driver updating config = %d, want 403", rec.Code)
	}
}

// The session carries the config, so the app can render correct labels
// from its very first screen without a follow-up request.
func TestSessionCarriesTheBusinessConfig(t *testing.T) {
	server := newTestServer(t)
	admin := adminForVertical(t, server, "school")

	me := admin.mustDo(http.MethodGet, "/api/v1/auth/me", nil, http.StatusOK)
	business, _ := me["business"].(map[string]any)
	config, _ := business["config"].(map[string]any)
	terminology, _ := config["terminology"].(map[string]any)

	if str(terminology, "customer") != "Student" {
		t.Fatalf("session config terminology = %+v", terminology)
	}
}
