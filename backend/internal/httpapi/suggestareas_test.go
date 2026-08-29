package httpapi

import (
	"fmt"
	"net/http"
	"testing"
)

func suggestionsOf(t *testing.T, admin *client) []map[string]any {
	t.Helper()
	resp := admin.mustDo(http.MethodGet, "/api/v1/service-areas/suggest", nil, http.StatusOK)
	raw, _ := resp["suggestions"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, s := range raw {
		out = append(out, s.(map[string]any))
	}
	return out
}

// A new business's customers already say where it delivers. Nobody should
// have to translate that into a radius in kilometres.
func TestSuggestsAnAreaFromWhereCustomersAlreadyAre(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	for i := 0; i < 6; i++ {
		createCustomer(t, admin, fmt.Sprintf("House %d", i), 17.0500+float64(i)*0.002, 79.2670+float64(i%3)*0.002)
	}

	got := suggestionsOf(t, admin)
	if len(got) != 1 {
		t.Fatalf("got %d suggestions for one cluster of customers, want 1", len(got))
	}
	if n := num(got[0], "customer_count"); n != 6 {
		t.Fatalf("suggestion covers %v customers, want all 6", n)
	}
	// The circle has to actually contain the people it claims.
	if r := num(got[0], "radius_meters"); r < 1000 {
		t.Fatalf("radius %v m is too tight to be usable", r)
	}
}

// Two towns are two areas. A single circle wide enough to cover both
// would also swallow everything between them, which is the bug that made
// service areas necessary in the first place.
func TestTwoTownsSuggestTwoAreas(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	for i := 0; i < 5; i++ {
		createCustomer(t, admin, fmt.Sprintf("Nalgonda %d", i), 17.0500+float64(i)*0.002, 79.2670)
	}
	for i := 0; i < 4; i++ {
		createCustomer(t, admin, fmt.Sprintf("Kodad %d", i), 16.9900+float64(i)*0.002, 79.9600)
	}

	got := suggestionsOf(t, admin)
	if len(got) != 2 {
		t.Fatalf("got %d suggestions for two towns, want 2", len(got))
	}
	// Biggest first — the place with the most customers is the one worth
	// offering an admin first.
	if num(got[0], "customer_count") != 5 || num(got[1], "customer_count") != 4 {
		t.Fatalf("suggestions came back %v/%v customers, want 5 then 4",
			num(got[0], "customer_count"), num(got[1], "customer_count"))
	}
}

// A couple of stray customers miles from anywhere is not a place. Offering
// it as one would put noise on the screen a new business most needs clear.
func TestATinyClusterIsNotSuggested(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	for i := 0; i < 5; i++ {
		createCustomer(t, admin, fmt.Sprintf("Town %d", i), 17.0500+float64(i)*0.002, 79.2670)
	}
	createCustomer(t, admin, "Far away", 15.5000, 78.0000)

	got := suggestionsOf(t, admin)
	if len(got) != 1 {
		t.Fatalf("got %d suggestions, want 1 — a lone customer is not a place", len(got))
	}
}

// Once an area covers them, they stop being suggested. This is what makes
// the prompt disappear after setup instead of nagging forever.
func TestCustomersInsideAnExistingAreaAreNotSuggested(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	for i := 0; i < 6; i++ {
		createCustomer(t, admin, fmt.Sprintf("House %d", i), 17.0500+float64(i)*0.002, 79.2670)
	}
	if got := suggestionsOf(t, admin); len(got) != 1 {
		t.Fatalf("expected a suggestion before any area exists, got %d", len(got))
	}

	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0500, "lng": 79.2670, "radius_meters": 6000,
	}, http.StatusCreated)

	if got := suggestionsOf(t, admin); len(got) != 0 {
		t.Fatalf("still suggesting %d areas after one was created to cover them", len(got))
	}
}

// A business that expands into a new town gets offered that town, and not
// the one it already set up.
func TestOnlyTheUncoveredTownIsSuggested(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	for i := 0; i < 5; i++ {
		createCustomer(t, admin, fmt.Sprintf("Nalgonda %d", i), 17.0500+float64(i)*0.002, 79.2670)
	}
	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda", "lat": 17.0500, "lng": 79.2670, "radius_meters": 6000,
	}, http.StatusCreated)

	for i := 0; i < 4; i++ {
		createCustomer(t, admin, fmt.Sprintf("Kodad %d", i), 16.9900+float64(i)*0.002, 79.9600)
	}

	got := suggestionsOf(t, admin)
	if len(got) != 1 {
		t.Fatalf("got %d suggestions, want just the new town", len(got))
	}
	if n := num(got[0], "customer_count"); n != 4 {
		t.Fatalf("suggestion covers %v customers, want the 4 in the uncovered town", n)
	}
}

// The name is read back out of the addresses the admin already typed, so
// the field arrives filled in rather than blank.
func TestSuggestionNamesItselfFromCustomerAddresses(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	for i := 0; i < 5; i++ {
		admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
			"name":    fmt.Sprintf("House %d", i),
			"phone":   "+919000000000",
			"address": fmt.Sprintf("%d, Clock Tower, Nalgonda", i+1),
			"lat":     17.0500 + float64(i)*0.002,
			"lng":     79.2670,
		}, http.StatusCreated)
	}

	got := suggestionsOf(t, admin)
	if len(got) != 1 {
		t.Fatalf("got %d suggestions, want 1", len(got))
	}
	if name := str(got[0], "name"); name != "Nalgonda" {
		t.Fatalf("suggested name = %q, want %q from the addresses", name, "Nalgonda")
	}
}

// Addresses that don't agree produce no name rather than a confidently
// wrong one — the admin types it instead.
func TestDisagreeingAddressesSuggestNoName(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	places := []string{"Alpha", "Beta", "Gamma", "Delta", "Epsilon"}
	for i, place := range places {
		admin.mustDo(http.MethodPost, "/api/v1/customers", map[string]any{
			"name":    fmt.Sprintf("House %d", i),
			"phone":   "+919000000000",
			"address": fmt.Sprintf("%d, %s", i+1, place),
			"lat":     17.0500 + float64(i)*0.002,
			"lng":     79.2670,
		}, http.StatusCreated)
	}

	got := suggestionsOf(t, admin)
	if len(got) != 1 {
		t.Fatalf("got %d suggestions, want 1", len(got))
	}
	if name := str(got[0], "name"); name != "" {
		t.Fatalf("suggested name = %q, want empty — the addresses don't agree on a place", name)
	}
}

// Customers with no pin can't say where anything is.
func TestUnpinnedCustomersProduceNoSuggestions(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	for i := 0; i < 5; i++ {
		createCustomer(t, admin, fmt.Sprintf("House %d", i), 0, 0)
	}

	if got := suggestionsOf(t, admin); len(got) != 0 {
		t.Fatalf("got %d suggestions from unpinned customers, want 0", len(got))
	}
}
