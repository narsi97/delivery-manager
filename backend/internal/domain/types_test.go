package domain

import "testing"

// The formats an admin and a driver each plausibly type for the same
// phone must all resolve to one key, or the driver simply cannot sign in.
func TestNormalizePhoneCollapsesEquivalentFormats(t *testing.T) {
	want := "9876543210"
	for _, input := range []string{
		"+91 98765 43210",
		"+919876543210",
		"919876543210",
		"09876543210",
		"9876543210",
		"98765-43210",
		"  9876543210  ",
	} {
		if got := NormalizePhone(input); got != want {
			t.Errorf("NormalizePhone(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestNormalizePhoneDistinguishesDifferentNumbers(t *testing.T) {
	if NormalizePhone("+919876543210") == NormalizePhone("+919876543211") {
		t.Fatal("two different numbers normalized to the same key")
	}
}

func TestNormalizePhoneHandlesShortAndEmptyInput(t *testing.T) {
	if got := NormalizePhone(""); got != "" {
		t.Errorf("NormalizePhone(\"\") = %q, want empty", got)
	}
	if got := NormalizePhone("+91 abc"); got != "91" {
		t.Errorf("NormalizePhone(%q) = %q, want %q", "+91 abc", got, "91")
	}
}

func TestRunsOnRespectsWeekdayMaskAndWindow(t *testing.T) {
	// 2026-08-21 is a Friday (weekday 5).
	const friday = "2026-08-21"

	sub := RecurringOrder{
		Active:      true,
		WeekdayMask: MaskFromWeekdays([]int{1, 2, 3, 4, 5}), // Mon-Fri
		StartDate:   "2026-08-01",
	}
	if !sub.RunsOn(friday) {
		t.Fatal("a Mon-Fri subscription should run on a Friday")
	}
	if sub.RunsOn("2026-08-22") {
		t.Fatal("a Mon-Fri subscription should not run on a Saturday")
	}

	beforeStart := sub
	beforeStart.StartDate = "2026-09-01"
	if beforeStart.RunsOn(friday) {
		t.Fatal("a subscription should not run before its start date")
	}

	ended := sub
	ended.EndDate = "2026-08-10"
	if ended.RunsOn(friday) {
		t.Fatal("a subscription should not run after its end date")
	}

	paused := sub
	paused.Active = false
	if paused.RunsOn(friday) {
		t.Fatal("an inactive subscription should never run")
	}

	malformed := sub
	if malformed.RunsOn("21-08-2026") {
		t.Fatal("a malformed date should not produce a delivery")
	}
}

func TestWeekdayMaskRoundTrip(t *testing.T) {
	days := []int{0, 3, 6}
	got := WeekdaysFromMask(MaskFromWeekdays(days))
	if len(got) != len(days) {
		t.Fatalf("round-tripped %v, want %v", got, days)
	}
	for i := range days {
		if got[i] != days[i] {
			t.Fatalf("round-tripped %v, want %v", got, days)
		}
	}

	// Out-of-range weekdays must be ignored rather than corrupting the
	// mask into unrelated days.
	if mask := MaskFromWeekdays([]int{-1, 7, 99}); mask != 0 {
		t.Fatalf("MaskFromWeekdays with out-of-range days = %d, want 0", mask)
	}
}

func TestHasPinTreatsNullIslandAsUnset(t *testing.T) {
	if (Customer{}).HasPin() {
		t.Fatal("a customer with no coordinates should not count as pinned")
	}
	if !(Customer{Lat: 12.98, Lng: 77.59}).HasPin() {
		t.Fatal("a customer with coordinates should count as pinned")
	}
}

func TestHasHomeTreatsNullIslandAsUnset(t *testing.T) {
	if (Business{}).HasHome() {
		t.Fatal("a business with no coordinates should not count as having a home location")
	}
	if !(Business{HomeLat: 12.98, HomeLng: 77.59}).HasHome() {
		t.Fatal("a business with coordinates should count as having a home location")
	}
}

func TestIsOverriddenDetectsQuantityAndSkip(t *testing.T) {
	unchanged := DailyOrder{Quantity: 2, BaseQuantity: 2, Status: StatusPending}
	if unchanged.IsOverridden() {
		t.Fatal("an untouched delivery should not read as overridden")
	}

	extra := DailyOrder{Quantity: 4, BaseQuantity: 2, Status: StatusPending}
	if !extra.IsOverridden() {
		t.Fatal("an increased quantity should read as overridden")
	}

	skipped := DailyOrder{Quantity: 2, BaseQuantity: 2, Status: StatusSkipped}
	if !skipped.IsOverridden() {
		t.Fatal("a skipped delivery should read as overridden")
	}
}
