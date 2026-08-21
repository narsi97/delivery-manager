// Package everyndays implements alternate-day (and every-third-day, and
// so on) delivery.
//
// This is the worked example of why extensions exist. A weekday mask
// describes "Monday, Wednesday, Friday" perfectly and "every other day"
// not at all — the second one doesn't align to a week, so it drifts
// across weekdays forever. Plenty of dairy customers take milk on
// alternate days, so this is a real requirement, not a demonstration.
//
// It is also the worked example of the layers composing: the interval
// itself is a **custom field on the customer** (layer 2), declared in the
// business's config, so enabling this rule needs no schema change and no
// new API — the admin console's existing custom-field form already edits
// it.
package everyndays

import (
	"context"
	"fmt"
	"time"

	"delivery-manager/internal/domain"
	"delivery-manager/internal/extensions"
)

// IntervalFieldKey is the customer custom field this extension reads. A
// business enabling this extension declares a number field with this key;
// customers who leave it blank (or set it to 1) are delivered to normally.
const IntervalFieldKey = "delivery_interval_days"

// FieldSpec is the declaration a business should add to its config to use
// this extension. Exported so the admin console can offer it as a
// one-click addition rather than making someone hand-type the key —
// getting the key wrong would silently disable the rule, which is exactly
// the kind of failure a user cannot diagnose.
func FieldSpec() domain.FieldSpec {
	return domain.FieldSpec{
		Key:       IntervalFieldKey,
		Label:     "Deliver every N days",
		Type:      domain.FieldNumber,
		AppliesTo: domain.TargetCustomer,
		Hint:      "Leave blank for every scheduled day. 2 means alternate days, counted from the subscription's start date.",
	}
}

type extension struct{}

func (extension) Name() string { return "every_n_days" }

func (extension) Description() string {
	return "Lets a customer take deliveries every N days (alternate days, every third day) instead of on fixed weekdays."
}

// AdjustGeneratedOrder narrows what the core scheduler already decided.
// The weekday mask runs first, in the core; this can only ever remove a
// delivery the mask allowed, never add one it didn't. That ordering keeps
// the mask meaningful — a customer set to Mon-Fri with an interval of 2
// gets alternate *weekdays*, never a Sunday.
func (e extension) AdjustGeneratedOrder(ctx context.Context, in extensions.OrderContext, order *domain.DailyOrder) (bool, error) {
	interval, ok := intervalFor(in.Customer)
	if !ok {
		return true, nil
	}

	start := in.Subscription.StartDate
	if start == "" {
		// With no anchor there is nothing to count from, so the interval
		// is meaningless rather than wrong — deliver normally instead of
		// guessing an origin.
		return true, nil
	}

	elapsed, err := daysBetween(start, in.Date)
	if err != nil {
		return false, err
	}
	if elapsed < 0 {
		// Before the subscription starts. The core already filters this
		// out (RecurringOrder.RunsOn), so reaching here means something
		// upstream changed; refuse rather than compute a negative
		// modulus whose sign depends on the language.
		return false, nil
	}

	return elapsed%interval == 0, nil
}

// intervalFor reads the interval from the customer's custom fields,
// returning ok=false for anything that means "no interval set". Values
// arrive as float64 because they have been through JSON.
func intervalFor(customer domain.Customer) (int, bool) {
	raw, present := customer.CustomFields[IntervalFieldKey]
	if !present || raw == nil {
		return 0, false
	}

	number, ok := raw.(float64)
	if !ok {
		return 0, false
	}
	interval := int(number)
	// 0 and 1 both mean "every scheduled day". Treating them as no-ops
	// rather than errors matters because 0 is what an empty number input
	// can round-trip to.
	if interval <= 1 {
		return 0, false
	}
	return interval, true
}

func daysBetween(from string, to string) (int, error) {
	start, err := time.Parse(domain.DateLayout, from)
	if err != nil {
		return 0, fmt.Errorf("subscription start date %q is not a date", from)
	}
	end, err := time.Parse(domain.DateLayout, to)
	if err != nil {
		return 0, fmt.Errorf("delivery date %q is not a date", to)
	}
	// Both parse in UTC with no clock component, so this subtraction is
	// exact whole days — no DST hazard, which is precisely why delivery
	// dates are stored as plain calendar strings (see domain.DateLayout).
	return int(end.Sub(start).Hours() / 24), nil
}

func init() {
	extensions.Register(extension{})
}
