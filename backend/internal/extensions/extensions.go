// Package extensions is the seam for per-business behaviour that
// configuration cannot express.
//
// Most per-tenant variation is data, not code, and belongs in
// domain.BusinessConfig: vocabulary, extra fields, what the driver must
// capture. This package is for the remainder — a rule that genuinely
// needs to run, like "this dairy's customers can subscribe to
// every-other-day delivery", which no weekday pattern can describe.
//
// Three properties are deliberate:
//
//   - **Opt-in per business.** An extension only runs for tenants whose
//     config names it (BusinessConfig.Extensions). A business that never
//     asked for a bespoke rule is unaffected by every bespoke rule that
//     exists — which is what makes it safe to keep adding them.
//   - **Compiled in, not loaded.** These are ordinary Go packages, built
//     into the binary and covered by the normal test suite. A plugin
//     runtime would buy dynamic loading nobody needs and cost the ability
//     to type-check and test the thing.
//   - **Quarantined.** Bespoke logic lives here and is referenced from
//     exactly one place in the core (order generation). When a customer
//     leaves, deleting their extension is deleting a directory — not
//     grepping handlers for their name.
//
// There is one hook point today because there is one real use for one.
// Adding the next (post-delivery notifications, invoicing) is the same
// shape: a narrow interface here, a resolved call at the one boundary in
// the core where the decision is actually made. Resist adding hooks
// before something needs them; an unused hook is an untested hook.
package extensions

import (
	"context"
	"fmt"
	"sort"

	"delivery-manager/internal/domain"
)

// Extension is the minimum every extension implements. Behaviour comes
// from the narrow optional interfaces below — an extension implements
// only the hooks it actually cares about.
type Extension interface {
	// Name is the stable identifier written into a business's config.
	// Changing it orphans every business that opted in, so treat it as
	// permanent once shipped.
	Name() string
	// Description is shown in the admin console next to the toggle.
	Description() string
}

// OrderContext is everything an order-generation hook is allowed to see:
// the tenant, the customer, the standing subscription, and the date being
// generated. Deliberately a value, not a store handle — a hook that could
// run arbitrary queries during a generation loop would be a performance
// and correctness hazard nobody could reason about.
type OrderContext struct {
	Business     domain.Business
	Customer     domain.Customer
	Subscription domain.RecurringOrder
	Date         string
}

// OrderGenerator adjusts or suppresses the daily order a subscription
// would otherwise produce for a date.
//
// Returning keep=false means "this subscription does not run today",
// which is the hook's most useful power: it is how scheduling patterns
// the weekday mask cannot express get implemented without touching the
// core scheduler.
type OrderGenerator interface {
	Extension
	AdjustGeneratedOrder(ctx context.Context, in OrderContext, order *domain.DailyOrder) (keep bool, err error)
}

var registry = map[string]Extension{}

// Register adds an extension to the process-wide registry. Called from a
// package init(); panics on a duplicate name, because two extensions
// answering to one name is a programming error that must not survive to
// runtime where it would silently resolve to whichever registered last.
func Register(e Extension) {
	name := e.Name()
	if name == "" {
		panic("extensions: an extension must have a name")
	}
	if _, exists := registry[name]; exists {
		panic(fmt.Sprintf("extensions: %q is registered twice", name))
	}
	registry[name] = e
}

// Available lists every registered extension, for an admin console that
// offers them as toggles. Sorted so the list is stable across restarts.
func Available() []Extension {
	out := make([]Extension, 0, len(registry))
	for _, e := range registry {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name() < out[j].Name() })
	return out
}

// Set is the resolved collection of extensions a single business has
// enabled. Resolve it once per operation, not once per record.
type Set struct {
	generators []OrderGenerator
	// Unknown are configured names with no registered implementation —
	// an extension removed from the binary while a business still names
	// it. Surfaced rather than silently ignored so an operator finds out
	// from a log line instead of from a customer asking why their rule
	// stopped applying.
	Unknown []string
}

// Resolve looks up the extensions a business has enabled. An empty or
// unrecognized list yields a Set whose hooks are all no-ops, so the
// common case — every business, today — costs one map lookup and nothing
// else.
func Resolve(names []string) Set {
	set := Set{}
	for _, name := range names {
		extension, ok := registry[name]
		if !ok {
			set.Unknown = append(set.Unknown, name)
			continue
		}
		if generator, ok := extension.(OrderGenerator); ok {
			set.generators = append(set.generators, generator)
		}
	}
	return set
}

// Empty reports whether this set would do anything, letting a caller skip
// building an OrderContext it doesn't need.
func (s Set) Empty() bool { return len(s.generators) == 0 }

// AdjustGeneratedOrder runs every enabled generator in configured order,
// stopping at the first one that suppresses the order.
//
// An error is returned rather than swallowed: a bespoke rule that cannot
// decide whether a delivery should happen must stop the generation run,
// not quietly produce a day's round that may be wrong. Half a milk round
// is worse than a visible failure an admin can retry.
func (s Set) AdjustGeneratedOrder(ctx context.Context, in OrderContext, order *domain.DailyOrder) (bool, error) {
	for _, generator := range s.generators {
		keep, err := generator.AdjustGeneratedOrder(ctx, in, order)
		if err != nil {
			return false, fmt.Errorf("extension %q: %w", generator.Name(), err)
		}
		if !keep {
			return false, nil
		}
	}
	return true, nil
}
