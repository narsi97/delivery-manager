package httpapi

import (
	"net/http"
	"testing"

	// Registers the built-in extensions, exactly as cmd/api does. Without
	// this the registry is empty and the config below would resolve to
	// nothing — which is itself the behaviour asserted in
	// TestUnknownExtensionIsIgnoredNotFatal.
	_ "delivery-manager/internal/extensions/all"
)

const (
	// A Friday, and the anchor every interval below is counted from.
	intervalStart = "2026-08-21"
)

func enableAlternateDays(t *testing.T, admin *client) {
	t.Helper()
	admin.mustDo(http.MethodPut, "/api/v1/config", map[string]any{
		"config": map[string]any{
			"custom_fields": []any{
				map[string]any{
					"key":        "delivery_interval_days",
					"label":      "Deliver every N days",
					"type":       "number",
					"applies_to": "customer",
				},
			},
			"extensions": []string{"every_n_days"},
		},
	}, http.StatusOK)
}

func subscribeFrom(t *testing.T, admin *client, customerID, productID, startDate string) {
	t.Helper()
	admin.mustDo(http.MethodPost, "/api/v1/recurring-orders", map[string]any{
		"customer_id": customerID,
		"product_id":  productID,
		"quantity":    1,
		"weekdays":    everyWeekday,
		"start_date":  startDate,
	}, http.StatusCreated)
}

func generatedOn(t *testing.T, admin *client, date string) []map[string]any {
	t.Helper()
	day := admin.mustDo(http.MethodPost, "/api/v1/day/generate?date="+date, nil, http.StatusOK)
	return stopsOf(t, day)
}

// The end-to-end proof that layer 4 works, and that it composes with
// layer 2: an alternate-day customer is driven entirely by a declared
// custom field plus a named extension, with no schema change and no
// branch in the scheduler.
func TestAlternateDayCustomerSkipsEveryOtherDay(t *testing.T) {
	server := newTestServer(t)
	admin := adminForVertical(t, server, "dairy")
	productID := firstProductID(t, admin)

	enableAlternateDays(t, admin)

	alternate := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Alternate Days", "lat": 12.98, "lng": 77.59,
		"custom_fields": map[string]any{"delivery_interval_days": 2},
	}, http.StatusCreated)
	subscribeFrom(t, admin, str(alternate, "id"), productID, intervalStart)

	// The customer nobody configured must be untouched by the extension.
	daily := createCustomer(t, admin, "Every Day", 12.99, 77.59)
	subscribeFrom(t, admin, daily, productID, intervalStart)

	for _, tc := range []struct {
		date          string
		wantAlternate bool
	}{
		{intervalStart, true}, // day 0
		{"2026-08-22", false}, // day 1
		{"2026-08-23", true},  // day 2
		{"2026-08-24", false},
	} {
		t.Run(tc.date, func(t *testing.T) {
			names := map[string]bool{}
			for _, stop := range generatedOn(t, admin, tc.date) {
				names[str(stop, "customer_name")] = true
			}

			if !names["Every Day"] {
				t.Fatalf("%s: the unconfigured customer was skipped — an extension leaked onto a customer who never opted in", tc.date)
			}
			if names["Alternate Days"] != tc.wantAlternate {
				t.Fatalf("%s: alternate-day customer scheduled = %v, want %v", tc.date, names["Alternate Days"], tc.wantAlternate)
			}
		})
	}
}

// Enabling an extension for one business must not affect another. This is
// the promise that makes it safe to keep accumulating bespoke rules.
func TestExtensionsAreScopedToTheBusinessThatEnabledThem(t *testing.T) {
	server := newTestServer(t)
	optedIn := adminForVertical(t, server, "dairy")
	productID := firstProductID(t, optedIn)

	enableAlternateDays(t, optedIn)
	customer := optedIn.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Alternate", "lat": 12.98, "lng": 77.59,
		"custom_fields": map[string]any{"delivery_interval_days": 2},
	}, http.StatusCreated)
	subscribeFrom(t, optedIn, str(customer, "id"), productID, intervalStart)

	// Day 1 is skipped while the extension is on.
	if stops := generatedOn(t, optedIn, "2026-08-22"); len(stops) != 0 {
		t.Fatalf("with the extension enabled, day 1 produced %d deliveries, want 0", len(stops))
	}

	// Turning it off restores the plain weekday behaviour, without
	// touching the customer's data.
	optedIn.mustDo(http.MethodPut, "/api/v1/config", map[string]any{
		"config": map[string]any{
			"custom_fields": []any{
				map[string]any{"key": "delivery_interval_days", "type": "number", "applies_to": "customer"},
			},
			"extensions": []string{},
		},
	}, http.StatusOK)

	if stops := generatedOn(t, optedIn, "2026-08-24"); len(stops) != 1 {
		t.Fatalf("with the extension disabled, %d deliveries were generated, want 1", len(stops))
	}
}

// A config naming an extension this build doesn't contain must degrade to
// the core behaviour, not take the morning's generation down.
func TestUnknownExtensionIsIgnoredNotFatal(t *testing.T) {
	server := newTestServer(t)
	admin := adminForVertical(t, server, "dairy")
	productID := firstProductID(t, admin)

	admin.mustDo(http.MethodPut, "/api/v1/config", map[string]any{
		"config": map[string]any{"extensions": []string{"a_rule_from_a_future_release"}},
	}, http.StatusOK)

	customer := createCustomer(t, admin, "Regular", 12.98, 77.59)
	subscribeFrom(t, admin, customer, productID, intervalStart)

	if stops := generatedOn(t, admin, "2026-08-22"); len(stops) != 1 {
		t.Fatalf("generated %d deliveries with an unknown extension configured, want 1", len(stops))
	}
}

// The admin console needs to offer extensions as labelled toggles rather
// than making someone type an identifier that fails silently.
func TestConfigListsAvailableExtensions(t *testing.T) {
	server := newTestServer(t)
	admin := adminForVertical(t, server, "dairy")

	resp := admin.mustDo(http.MethodGet, "/api/v1/config", nil, http.StatusOK)
	available, _ := resp["available_extensions"].([]any)
	if len(available) == 0 {
		t.Fatal("no available extensions were listed")
	}

	found := false
	for _, item := range available {
		entry, _ := item.(map[string]any)
		if str(entry, "name") == "every_n_days" {
			found = true
			if str(entry, "description") == "" {
				t.Error("every_n_days is listed without a description for the toggle")
			}
		}
	}
	if !found {
		t.Fatalf("every_n_days is not offered: %+v", available)
	}
}

// Regeneration stays idempotent with an extension in the loop — the same
// guarantee the core makes, since an admin may press Generate repeatedly.
func TestGenerationStaysIdempotentWithAnExtensionEnabled(t *testing.T) {
	server := newTestServer(t)
	admin := adminForVertical(t, server, "dairy")
	productID := firstProductID(t, admin)

	enableAlternateDays(t, admin)
	customer := admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
		"name": "Alternate", "lat": 12.98, "lng": 77.59,
		"custom_fields": map[string]any{"delivery_interval_days": 2},
	}, http.StatusCreated)
	subscribeFrom(t, admin, str(customer, "id"), productID, intervalStart)

	generatedOn(t, admin, "2026-08-23")
	second := generatedOn(t, admin, "2026-08-23")
	if len(second) != 1 {
		t.Fatalf("regeneration produced %d deliveries, want 1", len(second))
	}
}
