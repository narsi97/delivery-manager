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

// PATCH is partial: the stock control sends only a stock number and must
// not blank out the price someone else set.
func TestUpdateProductStockLeavesPriceAlone(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := firstProductID(t, admin)

	admin.mustDo(http.MethodPatch, "/api/v1/products/"+id,
		map[string]any{"price_cents": 5000}, http.StatusOK)
	updated := admin.mustDo(http.MethodPatch, "/api/v1/products/"+id,
		map[string]any{"stock_quantity": 120}, http.StatusOK)

	if got := num(updated, "stock_quantity"); got != 120 {
		t.Fatalf("stock_quantity = %v, want 120", got)
	}
	if got := num(updated, "price_cents"); got != 5000 {
		t.Fatalf("price_cents = %v after a stock-only update, want 5000", got)
	}
}

// Zero is a real value for both — "out of stock" and "no price set" are
// things an admin needs to be able to say, which is why the request uses
// pointers rather than treating zero as absent.
func TestUpdateProductAcceptsExplicitZero(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := firstProductID(t, admin)

	admin.mustDo(http.MethodPatch, "/api/v1/products/"+id,
		map[string]any{"stock_quantity": 50}, http.StatusOK)
	updated := admin.mustDo(http.MethodPatch, "/api/v1/products/"+id,
		map[string]any{"stock_quantity": 0}, http.StatusOK)

	if got := num(updated, "stock_quantity"); got != 0 {
		t.Fatalf("stock_quantity = %v, want 0 — running out must be expressible", got)
	}
}

func TestUpdateProductRejectsNegatives(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := firstProductID(t, admin)

	admin.mustDo(http.MethodPatch, "/api/v1/products/"+id,
		map[string]any{"price_cents": -1}, http.StatusBadRequest)
	admin.mustDo(http.MethodPatch, "/api/v1/products/"+id,
		map[string]any{"stock_quantity": -5}, http.StatusBadRequest)
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
