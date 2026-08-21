package extensions

import (
	"context"
	"errors"
	"testing"

	"delivery-manager/internal/domain"
)

type stub struct {
	name        string
	keep        bool
	err         error
	calls       *int
	newQuantity float64
}

func (s stub) Name() string        { return s.name }
func (s stub) Description() string { return "test stub" }

func (s stub) AdjustGeneratedOrder(ctx context.Context, in OrderContext, order *domain.DailyOrder) (bool, error) {
	if s.calls != nil {
		*s.calls++
	}
	if s.newQuantity > 0 {
		order.Quantity = s.newQuantity
	}
	return s.keep, s.err
}

func withRegistry(t *testing.T, entries ...Extension) {
	t.Helper()
	saved := registry
	registry = map[string]Extension{}
	for _, e := range entries {
		Register(e)
	}
	t.Cleanup(func() { registry = saved })
}

// The default path — no extensions configured — must cost nothing and
// change nothing.
func TestResolveEmptyIsANoOp(t *testing.T) {
	withRegistry(t)

	set := Resolve(nil)
	if !set.Empty() {
		t.Fatal("an empty configuration resolved to a non-empty set")
	}

	order := domain.DailyOrder{Quantity: 2}
	keep, err := set.AdjustGeneratedOrder(context.Background(), OrderContext{}, &order)
	if err != nil || !keep {
		t.Fatalf("keep = %v, err = %v; want true, nil", keep, err)
	}
	if order.Quantity != 2 {
		t.Fatalf("an empty set modified the order: %v", order.Quantity)
	}
}

func TestResolveOnlyRunsWhatABusinessOptedInto(t *testing.T) {
	optedIn, notOptedIn := 0, 0
	withRegistry(t,
		stub{name: "wanted", keep: true, calls: &optedIn},
		stub{name: "unwanted", keep: false, calls: &notOptedIn},
	)

	set := Resolve([]string{"wanted"})
	order := domain.DailyOrder{}
	keep, err := set.AdjustGeneratedOrder(context.Background(), OrderContext{}, &order)
	if err != nil {
		t.Fatalf("AdjustGeneratedOrder: %v", err)
	}
	if !keep {
		t.Fatal("the order was suppressed by an extension the business didn't enable")
	}
	if optedIn != 1 {
		t.Errorf("opted-in extension ran %d times, want 1", optedIn)
	}
	if notOptedIn != 0 {
		t.Errorf("an extension the business didn't enable ran %d times", notOptedIn)
	}
}

// An extension removed from the binary while a business still names it
// must be reported, not silently ignored.
func TestResolveReportsUnknownNames(t *testing.T) {
	withRegistry(t, stub{name: "known", keep: true})

	set := Resolve([]string{"known", "removed_last_year"})
	if len(set.Unknown) != 1 || set.Unknown[0] != "removed_last_year" {
		t.Fatalf("Unknown = %v, want [removed_last_year]", set.Unknown)
	}
}

func TestFirstSuppressionStopsTheChain(t *testing.T) {
	second := 0
	withRegistry(t,
		stub{name: "a_suppresses", keep: false},
		stub{name: "b_never_runs", keep: true, calls: &second},
	)

	order := domain.DailyOrder{}
	keep, err := Resolve([]string{"a_suppresses", "b_never_runs"}).AdjustGeneratedOrder(context.Background(), OrderContext{}, &order)
	if err != nil {
		t.Fatalf("AdjustGeneratedOrder: %v", err)
	}
	if keep {
		t.Fatal("the order survived a suppressing extension")
	}
	if second != 0 {
		t.Error("extensions kept running after the order was suppressed")
	}
}

// A rule that can't decide must stop the generation run — half a round is
// worse than a visible failure.
func TestAnErrorPropagatesAndNamesTheExtension(t *testing.T) {
	withRegistry(t, stub{name: "broken", err: errors.New("upstream unavailable")})

	order := domain.DailyOrder{}
	_, err := Resolve([]string{"broken"}).AdjustGeneratedOrder(context.Background(), OrderContext{}, &order)
	if err == nil {
		t.Fatal("a failing extension was ignored")
	}
	if got := err.Error(); got == "upstream unavailable" {
		t.Fatalf("error %q doesn't say which extension failed", got)
	}
}

func TestExtensionsCanModifyTheOrder(t *testing.T) {
	withRegistry(t, stub{name: "doubler", keep: true, newQuantity: 4})

	order := domain.DailyOrder{Quantity: 2}
	if _, err := Resolve([]string{"doubler"}).AdjustGeneratedOrder(context.Background(), OrderContext{}, &order); err != nil {
		t.Fatalf("AdjustGeneratedOrder: %v", err)
	}
	if order.Quantity != 4 {
		t.Fatalf("quantity = %v, want 4", order.Quantity)
	}
}

func TestRegisterRejectsDuplicatesAndBlankNames(t *testing.T) {
	withRegistry(t)

	Register(stub{name: "once"})

	assertPanics(t, "duplicate name", func() { Register(stub{name: "once"}) })
	assertPanics(t, "blank name", func() { Register(stub{name: ""}) })
}

func TestAvailableIsSorted(t *testing.T) {
	withRegistry(t, stub{name: "zebra"}, stub{name: "alpha"}, stub{name: "middle"})

	names := []string{}
	for _, e := range Available() {
		names = append(names, e.Name())
	}
	want := []string{"alpha", "middle", "zebra"}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("Available() = %v, want %v", names, want)
		}
	}
}

func assertPanics(t *testing.T, what string, fn func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Fatalf("%s did not panic", what)
		}
	}()
	fn()
}
