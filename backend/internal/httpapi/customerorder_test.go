package httpapi

import (
	"net/http"
	"testing"
)

// orderedNames returns today's routed stops in visiting order.
func orderedNames(t *testing.T, admin *client) []string {
	t.Helper()
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	type placed struct {
		name string
		seq  int
	}
	out := []placed{}
	for _, stop := range stopsOf(t, day) {
		if str(stop, "route_id") == "" {
			continue
		}
		seq, _ := stop["sequence"].(float64)
		out = append(out, placed{name: str(stop, "customer_name"), seq: int(seq)})
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].seq < out[j-1].seq; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	names := make([]string, 0, len(out))
	for _, p := range out {
		names = append(names, p.name)
	}
	return names
}

// A roster dragged into an order is driven in that order. This is the
// whole point: a dairy that has done the same streets for years knows
// something the shortest path does not.
func TestDraggingTheRosterSetsTheVisitingOrder(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 12.9700, "home_lng": 77.5946,
	}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Jayanagar", "lat": 12.9700, "lng": 77.5946, "radius_meters": 8000,
	}, http.StatusCreated)

	ids := map[string]string{}
	for i, name := range []string{"Anil", "Bhavna", "Chetan", "Divya"} {
		id := createCustomer(t, admin, name, 12.9700+float64(i)*0.002, 77.5946)
		createSubscription(t, admin, id, productID, 1)
		ids[name] = id
	}
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	want := []string{"Divya", "Anil", "Chetan", "Bhavna"}
	ordered := make([]string, 0, len(want))
	for _, name := range want {
		ordered = append(ordered, ids[name])
	}
	admin.mustDo(http.MethodPost, "/api/v1/customers/order",
		map[string]any{"customer_ids": ordered}, http.StatusOK)

	if got := orderedNames(t, admin); !sameOrder(got, want) {
		t.Fatalf("route order is %v, want the order the admin dragged: %v", got, want)
	}
	// And it is not a one-read fluke — the day rebuilds itself constantly.
	if got := orderedNames(t, admin); !sameOrder(got, want) {
		t.Fatalf("on a second read the order is %v, want %v", got, want)
	}
}

// Ordering some customers must not silently take route optimization away
// from the rest. Unranked customers stay in one band, where the shortest
// path still decides.
func TestUnrankedCustomersKeepTheirOptimizedOrder(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 12.9700, "home_lng": 77.5946,
	}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Jayanagar", "lat": 12.9700, "lng": 77.5946, "radius_meters": 9000,
	}, http.StatusCreated)

	// Far, then near, then nearer — an order the optimizer would undo.
	far := createCustomer(t, admin, "Far", 12.9700, 77.6500)
	near := createCustomer(t, admin, "Near", 12.9700, 77.5960)
	mid := createCustomer(t, admin, "Mid", 12.9700, 77.6100)
	for _, id := range []string{far, near, mid} {
		createSubscription(t, admin, id, productID, 1)
	}
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	baseline := orderedNames(t, admin)

	// Rank nobody in this set; ranking a different customer entirely
	// must leave these three exactly as the optimizer had them.
	other := createCustomer(t, admin, "Other", 12.9705, 77.5950)
	createSubscription(t, admin, other, productID, 1)
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/customers/order",
		map[string]any{"customer_ids": []string{other}}, http.StatusOK)

	got := orderedNames(t, admin)
	if len(got) == 0 || got[0] != "Other" {
		t.Fatalf("the one ranked customer is not first: %v", got)
	}
	rest := got[1:]
	if !sameOrder(rest, baseline) {
		t.Fatalf("unranked customers were re-ordered to %v, want the optimizer's %v", rest, baseline)
	}
}

// Clearing hands the order back to the optimizer.
func TestClearingTheOrderRestoresTheShortestPath(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 12.9700, "home_lng": 77.5946,
	}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Jayanagar", "lat": 12.9700, "lng": 77.5946, "radius_meters": 9000,
	}, http.StatusCreated)

	ids := []string{}
	for i, name := range []string{"Near", "Mid", "Far"} {
		id := createCustomer(t, admin, name, 12.9700, 77.5960+float64(i)*0.02)
		createSubscription(t, admin, id, productID, 1)
		ids = append(ids, id)
	}
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	optimized := orderedNames(t, admin)

	reversed := []string{ids[2], ids[1], ids[0]}
	admin.mustDo(http.MethodPost, "/api/v1/customers/order",
		map[string]any{"customer_ids": reversed}, http.StatusOK)
	if got := orderedNames(t, admin); sameOrder(got, optimized) {
		t.Fatalf("dragging changed nothing: still %v", got)
	}

	admin.mustDo(http.MethodPost, "/api/v1/customers/order",
		map[string]any{"customer_ids": ids, "clear": true}, http.StatusOK)
	if got := orderedNames(t, admin); !sameOrder(got, optimized) {
		t.Fatalf("after clearing the order is %v, want the optimizer's %v", got, optimized)
	}
}

// A tier still outranks the hand order: dragging a house to the top does
// not put it ahead of the shop that opens at six.
func TestTheTierStillBeatsTheHandOrder(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 12.9700, "home_lng": 77.5946,
	}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Jayanagar", "lat": 12.9700, "lng": 77.5946, "radius_meters": 9000,
	}, http.StatusCreated)

	house := createCustomer(t, admin, "House", 12.9700, 77.5960)
	shop := createCustomer(t, admin, "Shop", 12.9700, 77.6300)
	admin.mustDo(http.MethodPatch, "/api/v1/customers/"+shop,
		map[string]any{"priority": "business"}, http.StatusOK)
	for _, id := range []string{house, shop} {
		createSubscription(t, admin, id, productID, 1)
	}
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	admin.mustDo(http.MethodPost, "/api/v1/customers/order",
		map[string]any{"customer_ids": []string{house, shop}}, http.StatusOK)

	got := orderedNames(t, admin)
	if len(got) == 0 || got[0] != "Shop" {
		t.Fatalf("order is %v — the shop's tier must still come first", got)
	}
}

// An id from another business can't renumber anything.
func TestOrderingRefusesACustomerFromAnotherBusiness(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	mine := createCustomer(t, admin, "Mine", 12.97, 77.59)

	other := secondBusinessAdminClient(t, server)
	theirs := createCustomer(t, other, "Theirs", 12.97, 77.59)

	admin.mustDo(http.MethodPost, "/api/v1/customers/order",
		map[string]any{"customer_ids": []string{mine, theirs}}, http.StatusNotFound)

	list := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	raw, _ := list["customers"].([]any)
	for _, c := range raw {
		customer := c.(map[string]any)
		if rank, _ := customer["rank"].(float64); rank != 0 {
			t.Fatalf("%s was ranked %v by a request that should have been refused",
				str(customer, "name"), rank)
		}
	}
}

func sameOrder(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
