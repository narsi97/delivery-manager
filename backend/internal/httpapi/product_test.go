package httpapi

import (
	"net/http"
	"testing"
)

// A business that set up "Milk 1L" before it settled on a price could
// never put one on it — products were create-and-list only.
func TestUpdateProductPriceAndUnit(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := firstProductID(t, admin)

	updated := admin.mustDo(http.MethodPatch, "/api/v1/products/"+id, map[string]any{
		"price_cents": 6500,
		"unit":        "packet",
	}, http.StatusOK)

	if got := num(updated, "price_cents"); got != 6500 {
		t.Fatalf("price_cents = %v, want 6500", got)
	}
	if got := str(updated, "unit"); got != "packet" {
		t.Fatalf("unit = %q, want packet", got)
	}

	listed := admin.mustDo(http.MethodGet, "/api/v1/products", nil, http.StatusOK)
	for _, raw := range listed["products"].([]any) {
		p := raw.(map[string]any)
		if str(p, "id") == id && num(p, "price_cents") != 6500 {
			t.Fatalf("price did not persist: %v", num(p, "price_cents"))
		}
	}
}

// Milk filled on Monday is not still there on Friday. Stock belongs to a
// date, and a date nobody has stocked has none of it — this is the whole
// reason product_stock exists, so it is the test that must not rot.
func TestStockIsPerDayAndStartsAtZero(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := firstProductID(t, admin)

	admin.mustDo(http.MethodPut, "/api/v1/products/"+id+"/stock",
		map[string]any{"date": "2026-09-08", "quantity": 40}, http.StatusOK)

	monday := admin.mustDo(http.MethodGet, "/api/v1/products/demand?date=2026-09-08", nil, http.StatusOK)
	if got := num(monday["stock"].(map[string]any), id); got != 40 {
		t.Fatalf("stock on the day it was entered = %v, want 40", got)
	}

	friday := admin.mustDo(http.MethodGet, "/api/v1/products/demand?date=2026-09-12", nil, http.StatusOK)
	if stock, _ := friday["stock"].(map[string]any); len(stock) != 0 {
		t.Fatalf("stock on an unstocked day = %v, want nothing — every day starts empty", stock)
	}
}

// Entering it again replaces it rather than adding to it: the number is
// what is in the cold room, not a running tally of what arrived.
func TestSettingStockAgainReplacesTheDaysFigure(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := firstProductID(t, admin)

	admin.mustDo(http.MethodPut, "/api/v1/products/"+id+"/stock",
		map[string]any{"date": "2026-09-08", "quantity": 40}, http.StatusOK)
	admin.mustDo(http.MethodPut, "/api/v1/products/"+id+"/stock",
		map[string]any{"date": "2026-09-08", "quantity": 25}, http.StatusOK)

	day := admin.mustDo(http.MethodGet, "/api/v1/products/demand?date=2026-09-08", nil, http.StatusOK)
	if got := num(day["stock"].(map[string]any), id); got != 25 {
		t.Fatalf("stock = %v, want 25", got)
	}
}

// Zero is a real value — "we ran out" has to be sayable, and it is not
// the same as never having entered a figure only because the screen
// shows both as nothing.
func TestStockAcceptsZeroAndRefusesNegatives(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := firstProductID(t, admin)

	admin.mustDo(http.MethodPut, "/api/v1/products/"+id+"/stock",
		map[string]any{"date": "2026-09-08", "quantity": 50}, http.StatusOK)
	admin.mustDo(http.MethodPut, "/api/v1/products/"+id+"/stock",
		map[string]any{"date": "2026-09-08", "quantity": 0}, http.StatusOK)

	day := admin.mustDo(http.MethodGet, "/api/v1/products/demand?date=2026-09-08", nil, http.StatusOK)
	if got := num(day["stock"].(map[string]any), id); got != 0 {
		t.Fatalf("stock = %v, want 0 — running out must be expressible", got)
	}

	admin.mustDo(http.MethodPut, "/api/v1/products/"+id+"/stock",
		map[string]any{"date": "2026-09-08", "quantity": -5}, http.StatusBadRequest)
}

// The old way out. A client still sending stock with the product would
// otherwise be silently setting a number nothing reads.
func TestUpdateProductRefusesStock(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := firstProductID(t, admin)

	admin.mustDo(http.MethodPatch, "/api/v1/products/"+id,
		map[string]any{"stock_quantity": 120}, http.StatusBadRequest)
}

func TestUpdateProductRejectsNegatives(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := firstProductID(t, admin)

	admin.mustDo(http.MethodPatch, "/api/v1/products/"+id,
		map[string]any{"price_cents": -1}, http.StatusBadRequest)
}

// Another business's product must not be editable, and must read as
// not-found rather than forbidden.
func TestUpdateProductIsScopedToTheBusiness(t *testing.T) {
	server := newTestServer(t)
	first := adminClient(t, server)
	second := secondBusinessAdminClient(t, server)

	id := firstProductID(t, first)
	second.mustDo(http.MethodPatch, "/api/v1/products/"+id,
		map[string]any{"price_cents": 100}, http.StatusNotFound)
}

// Stock is only useful next to what the day actually needs.
func TestProductDemandCountsPendingDeliveries(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	a := createCustomer(t, admin, "A", 12.9750, 77.5946)
	b := createCustomer(t, admin, "B", 12.9760, 77.5946)
	createSubscription(t, admin, a, productID, 2)
	createSubscription(t, admin, b, productID, 3)
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	demand := admin.mustDo(http.MethodGet, "/api/v1/products/demand", nil, http.StatusOK)
	needed, _ := demand["needed"].(map[string]any)
	if got := needed[productID]; got != float64(5) {
		t.Fatalf("needed = %v, want 5 (2 + 3)", got)
	}
}

// A delivery already made is not still to be loaded.
func TestProductDemandIgnoresCompletedDeliveries(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)

	a := createCustomer(t, admin, "A", 12.9750, 77.5946)
	createSubscription(t, admin, a, productID, 4)
	day := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)

	stopID := str(stopsOf(t, day)[0], "id")
	admin.mustDo(http.MethodPatch, "/api/v1/orders/"+stopID,
		map[string]any{"status": "delivered"}, http.StatusOK)

	demand := admin.mustDo(http.MethodGet, "/api/v1/products/demand", nil, http.StatusOK)
	needed, _ := demand["needed"].(map[string]any)
	if got, ok := needed[productID]; ok && got != float64(0) {
		t.Fatalf("needed = %v after the delivery was made, want nothing left", got)
	}
}

// Yesterday's figure is offered for today, and offering is all it does.
// Milk does not carry over — that is why stock is per day — so the
// suggestion must never read as stock somebody has.
func TestYesterdaysStockIsSuggestedButNotCounted(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := firstProductID(t, admin)

	admin.mustDo(http.MethodPut, "/api/v1/products/"+id+"/stock",
		map[string]any{"date": "2026-09-08", "quantity": 40}, http.StatusOK)

	today := admin.mustDo(http.MethodGet, "/api/v1/products/demand?date=2026-09-09", nil, http.StatusOK)
	if stock, _ := today["stock"].(map[string]any); len(stock) != 0 {
		t.Errorf("stock = %v, want nothing — yesterday's milk is not today's", stock)
	}
	if got := num(today["suggested"].(map[string]any), id); got != 40 {
		t.Errorf("suggested = %v, want 40", got)
	}
}

// Once today has a figure of its own, there is nothing to suggest.
func TestNothingIsSuggestedOnceTheDayIsStocked(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := firstProductID(t, admin)

	admin.mustDo(http.MethodPut, "/api/v1/products/"+id+"/stock",
		map[string]any{"date": "2026-09-08", "quantity": 40}, http.StatusOK)
	admin.mustDo(http.MethodPut, "/api/v1/products/"+id+"/stock",
		map[string]any{"date": "2026-09-09", "quantity": 12}, http.StatusOK)

	day := admin.mustDo(http.MethodGet, "/api/v1/products/demand?date=2026-09-09", nil, http.StatusOK)
	if got := num(day["stock"].(map[string]any), id); got != 12 {
		t.Errorf("stock = %v, want 12", got)
	}
	if suggested, _ := day["suggested"].(map[string]any); len(suggested) != 0 {
		t.Errorf("suggested = %v, want nothing once the day has its own figure", suggested)
	}
}

// "Same as yesterday" is one call, so a morning cannot end up half
// written.
func TestStockCanBeSetForEverySizeAtOnce(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	listed := admin.mustDo(http.MethodGet, "/api/v1/products", nil, http.StatusOK)
	products := listed["products"].([]any)

	want := map[string]any{}
	for _, raw := range products {
		want[str(raw.(map[string]any), "id")] = 7
	}
	admin.mustDo(http.MethodPut, "/api/v1/products/stock",
		map[string]any{"date": "2026-09-08", "stock": want}, http.StatusOK)

	day := admin.mustDo(http.MethodGet, "/api/v1/products/demand?date=2026-09-08", nil, http.StatusOK)
	stock := day["stock"].(map[string]any)
	if len(stock) != len(products) {
		t.Fatalf("stocked %d of %d products", len(stock), len(products))
	}
	for id := range want {
		if got := num(stock, id); got != 7 {
			t.Errorf("stock[%s] = %v, want 7", id, got)
		}
	}
}

// A batch naming somebody else's product writes nothing at all.
func TestBulkStockIsScopedToTheBusiness(t *testing.T) {
	server := newTestServer(t)
	first := adminClient(t, server)
	second := secondBusinessAdminClient(t, server)
	theirs := firstProductID(t, second)

	first.mustDo(http.MethodPut, "/api/v1/products/stock",
		map[string]any{"date": "2026-09-08", "stock": map[string]any{theirs: 9}}, http.StatusNotFound)

	day := second.mustDo(http.MethodGet, "/api/v1/products/demand?date=2026-09-08", nil, http.StatusOK)
	if stock, _ := day["stock"].(map[string]any); len(stock) != 0 {
		t.Errorf("stock = %v, want nothing — another business wrote into it", stock)
	}
}
