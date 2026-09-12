package httpapi

import (
	"net/http"
	"testing"
	"time"

	"delivery-manager/internal/domain"
)

// A holiday is two dates, not a flag somebody has to remember to unset.
//
// The old pause was indefinite: an admin told the app a household had gone
// away and then had to remember, three weeks later, to switch them back
// on. The failure mode was silent and one-directional — nobody rings to
// say "you have correctly not delivered my milk" — so a forgotten resume
// reads as a household that quietly stopped being a customer.
//
// Coming back is derived from the dates rather than scheduled. There is no
// nightly job to miss, no row to flip: the day simply asks whether this
// date falls inside the span, and a date after it is not inside it.

// dayOffset is a date this many days from today, in the layout everything
// in this app writes dates in.
func dayOffset(days int) string {
	return time.Now().UTC().AddDate(0, 0, days).Format(domain.DateLayout)
}

func deliveriesOn(t *testing.T, admin *client, date string) float64 {
	t.Helper()
	day := admin.mustDo(http.MethodPost, "/api/v1/day/generate?date="+date, nil, http.StatusOK)
	summary, _ := day["summary"].(map[string]any)
	return num(summary, "total")
}

func TestAwaySpanStopsDeliveriesAndEndsByItself(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	customer := createCustomer(t, admin, "Away For A Fortnight", 12.98, 77.59)
	createSubscription(t, admin, customer, productID, 1)

	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+customer, map[string]any{
		"paused_from":  dayOffset(3),
		"paused_until": dayOffset(9),
	}, http.StatusOK)

	for _, tc := range []struct {
		what string
		day  int
		want float64
	}{
		{"the day before they leave", 2, 1},
		{"the day they leave", 3, 0},
		{"the middle of the holiday", 6, 0},
		{"the last day away", 9, 0},
		{"the day after they are back", 10, 1},
	} {
		if got := deliveriesOn(t, admin, dayOffset(tc.day)); got != tc.want {
			t.Fatalf("%s: generated %v deliveries, want %v", tc.what, got, tc.want)
		}
	}
}

// Open at one end is a real thing to mean: "they leave on Friday, no idea
// when they are back", and "they are away now, back on the 28th" typed by
// somebody who never recorded the day they left.
func TestAwaySpansOpenAtEitherEndAreHonoured(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	from := createCustomer(t, admin, "Leaves On Friday", 12.98, 77.59)
	createSubscription(t, admin, from, productID, 1)
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+from, map[string]any{
		"paused_from": dayOffset(5),
	}, http.StatusOK)

	if got := deliveriesOn(t, admin, dayOffset(4)); got != 1 {
		t.Fatalf("before an open-ended departure: generated %v, want 1", got)
	}
	if got := deliveriesOn(t, admin, dayOffset(40)); got != 0 {
		t.Fatalf("long after an open-ended departure: generated %v, want 0", got)
	}

	until := createCustomer(t, admin, "Back On The 28th", 12.99, 77.60)
	createSubscription(t, admin, until, productID, 1)
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+from, map[string]any{
		"paused_from": "", "paused_until": "",
	}, http.StatusOK)
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+until, map[string]any{
		"paused_until": dayOffset(7),
	}, http.StatusOK)

	// Both customers deliver again after the 7th; only the one still away
	// is missing before it.
	if got := deliveriesOn(t, admin, dayOffset(7)); got != 1 {
		t.Fatalf("on the last day away: generated %v, want 1 (the other customer only)", got)
	}
	if got := deliveriesOn(t, admin, dayOffset(8)); got != 2 {
		t.Fatalf("the day after: generated %v, want 2", got)
	}
}

// The manual pause has not gone anywhere. "Stop, I will say when" is a
// different instruction from "stop until the 28th", and it is the honest
// one when nobody knows the date.
func TestIndefinitePauseAndManualResumeStillWork(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	customer := createCustomer(t, admin, "Stopped Until Further Notice", 12.98, 77.59)
	createSubscription(t, admin, customer, productID, 1)

	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+customer, map[string]any{"active": false}, http.StatusOK)
	if got := deliveriesOn(t, admin, dayOffset(2)); got != 0 {
		t.Fatalf("paused: generated %v, want 0", got)
	}
	if got := deliveriesOn(t, admin, dayOffset(400)); got != 0 {
		t.Fatalf("an indefinite pause must not expire on its own: generated %v, want 0", got)
	}

	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+customer, map[string]any{"active": true}, http.StatusOK)
	if got := deliveriesOn(t, admin, dayOffset(3)); got != 1 {
		t.Fatalf("resumed by hand: generated %v, want 1", got)
	}
}

// Clearing the dates is "they came back early", and it has to work on a
// day already inside the span.
func TestClearingAnAwaySpanBringsThemBackToday(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	customer := createCustomer(t, admin, "Home Early", 12.98, 77.59)
	createSubscription(t, admin, customer, productID, 1)

	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+customer, map[string]any{
		"paused_from": dayOffset(1), "paused_until": dayOffset(20),
	}, http.StatusOK)
	if got := deliveriesOn(t, admin, dayOffset(5)); got != 0 {
		t.Fatalf("away: generated %v, want 0", got)
	}

	back := admin.mustDo(http.MethodPatch, "/api/v1/customers/"+customer, map[string]any{
		"paused_from": "", "paused_until": "",
	}, http.StatusOK)
	if str(back, "paused_from") != "" || str(back, "paused_until") != "" {
		t.Fatalf("the span should be gone, got %q to %q", str(back, "paused_from"), str(back, "paused_until"))
	}
	if got := deliveriesOn(t, admin, dayOffset(6)); got != 1 {
		t.Fatalf("back early: generated %v, want 1", got)
	}
}

func TestNonsensicalAwaySpansAreRefused(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	customer := createCustomer(t, admin, "Customer", 12.98, 77.59)

	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"a date in the wrong order", map[string]any{"paused_from": "28-09-2026"}},
		{"a date that is not a date", map[string]any{"paused_until": "next week"}},
		{"back before they left", map[string]any{"paused_from": dayOffset(9), "paused_until": dayOffset(3)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec, _ := admin.do(http.MethodPatch, "/api/v1/customers/"+customer, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("PATCH %v = %d, want 400 (body: %s)", tc.body, rec.Code, rec.Body.String())
			}
		})
	}

	// And nothing was written by the refused attempts.
	current := onlyCustomer(t, admin)
	if str(current, "paused_from") != "" || str(current, "paused_until") != "" {
		t.Fatalf("a refused span still reached the customer: %q to %q",
			str(current, "paused_from"), str(current, "paused_until"))
	}
}

func onlyCustomer(t *testing.T, admin *client) map[string]any {
	t.Helper()
	resp := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	list, _ := resp["customers"].([]any)
	if len(list) != 1 {
		t.Fatalf("expected one customer on the list, got %d", len(list))
	}
	one, _ := list[0].(map[string]any)
	return one
}
