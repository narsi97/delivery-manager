package everyndays

import (
	"context"
	"testing"

	"delivery-manager/internal/domain"
	"delivery-manager/internal/extensions"
)

func contextFor(intervalDays any, startDate string, date string) extensions.OrderContext {
	customer := domain.Customer{ID: "c1", CustomFields: domain.FieldValues{}}
	if intervalDays != nil {
		customer.CustomFields[IntervalFieldKey] = intervalDays
	}
	return extensions.OrderContext{
		Customer:     customer,
		Subscription: domain.RecurringOrder{StartDate: startDate},
		Date:         date,
	}
}

func TestAlternateDaysDeliversEveryOtherDay(t *testing.T) {
	const start = "2026-08-21"
	cases := map[string]bool{
		"2026-08-21": true,  // day 0
		"2026-08-22": false, // day 1
		"2026-08-23": true,  // day 2
		"2026-08-24": false,
		"2026-08-25": true,
		"2026-09-04": true, // day 14, still in step a fortnight later
	}

	for date, want := range cases {
		t.Run(date, func(t *testing.T) {
			order := domain.DailyOrder{}
			keep, err := extension{}.AdjustGeneratedOrder(context.Background(), contextFor(float64(2), start, date), &order)
			if err != nil {
				t.Fatalf("AdjustGeneratedOrder: %v", err)
			}
			if keep != want {
				t.Fatalf("keep = %v, want %v", keep, want)
			}
		})
	}
}

func TestEveryThirdDay(t *testing.T) {
	const start = "2026-08-21"
	for _, tc := range []struct {
		date string
		want bool
	}{
		{"2026-08-21", true},
		{"2026-08-22", false},
		{"2026-08-23", false},
		{"2026-08-24", true},
	} {
		order := domain.DailyOrder{}
		keep, err := extension{}.AdjustGeneratedOrder(context.Background(), contextFor(float64(3), start, tc.date), &order)
		if err != nil {
			t.Fatalf("%s: %v", tc.date, err)
		}
		if keep != tc.want {
			t.Errorf("%s: keep = %v, want %v", tc.date, keep, tc.want)
		}
	}
}

// Everything that means "no interval configured" must leave the customer
// on their normal schedule. An extension that silently suppressed
// deliveries for customers who never opted in would be catastrophic —
// this is the case worth being paranoid about.
func TestNoIntervalMeansDeliverNormally(t *testing.T) {
	cases := map[string]any{
		"field absent":        nil,
		"explicit zero":       float64(0),
		"one is every day":    float64(1),
		"negative":            float64(-3),
		"wrong type (string)": "2",
		"wrong type (bool)":   true,
	}

	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			order := domain.DailyOrder{}
			in := contextFor(value, "2026-08-21", "2026-08-22") // a day that would be skipped if the interval applied
			keep, err := extension{}.AdjustGeneratedOrder(context.Background(), in, &order)
			if err != nil {
				t.Fatalf("AdjustGeneratedOrder: %v", err)
			}
			if !keep {
				t.Fatal("a customer with no usable interval was skipped")
			}
		})
	}
}

// With no anchor date the interval can't be counted from anywhere, so the
// safe reading is "deliver", not "guess an origin and start skipping".
func TestMissingStartDateDeliversNormally(t *testing.T) {
	order := domain.DailyOrder{}
	keep, err := extension{}.AdjustGeneratedOrder(context.Background(), contextFor(float64(2), "", "2026-08-22"), &order)
	if err != nil {
		t.Fatalf("AdjustGeneratedOrder: %v", err)
	}
	if !keep {
		t.Fatal("a subscription with no start date was skipped")
	}
}

func TestMalformedDatesAreReportedNotGuessed(t *testing.T) {
	order := domain.DailyOrder{}
	if _, err := (extension{}).AdjustGeneratedOrder(context.Background(), contextFor(float64(2), "21-08-2026", "2026-08-22"), &order); err == nil {
		t.Fatal("a malformed start date was accepted")
	}
	if _, err := (extension{}).AdjustGeneratedOrder(context.Background(), contextFor(float64(2), "2026-08-21", "not-a-date"), &order); err == nil {
		t.Fatal("a malformed delivery date was accepted")
	}
}

func TestDatesBeforeTheStartAreNotDelivered(t *testing.T) {
	order := domain.DailyOrder{}
	keep, err := extension{}.AdjustGeneratedOrder(context.Background(), contextFor(float64(2), "2026-08-21", "2026-08-19"), &order)
	if err != nil {
		t.Fatalf("AdjustGeneratedOrder: %v", err)
	}
	if keep {
		t.Fatal("a date before the subscription start was delivered")
	}
}

func TestRegisteredUnderItsStableName(t *testing.T) {
	set := extensions.Resolve([]string{"every_n_days"})
	if set.Empty() {
		t.Fatal("every_n_days did not resolve — the init() registration or the name has changed")
	}
	if len(set.Unknown) != 0 {
		t.Fatalf("unknown extensions: %v", set.Unknown)
	}
}

// The declaration the admin console offers must match the key the
// extension actually reads, or enabling it would silently do nothing.
func TestFieldSpecMatchesTheKeyTheExtensionReads(t *testing.T) {
	spec := FieldSpec()
	if spec.Key != IntervalFieldKey {
		t.Fatalf("FieldSpec key = %q, want %q", spec.Key, IntervalFieldKey)
	}
	if spec.Type != domain.FieldNumber || spec.AppliesTo != domain.TargetCustomer {
		t.Fatalf("FieldSpec is not a customer number field: %+v", spec)
	}
	if err := (domain.BusinessConfig{CustomFields: []domain.FieldSpec{spec}}).Validate(); err != nil {
		t.Fatalf("FieldSpec is not a config a business could save: %v", err)
	}
}
