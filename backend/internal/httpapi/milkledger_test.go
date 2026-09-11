package httpapi

import (
	"net/http"
	"testing"
)

// productIDByName finds one of the dairy preset's products — Milk 500ml,
// 750ml and 1L — without the test depending on the order they were made.
func productIDByName(t *testing.T, admin *client, name string) string {
	t.Helper()
	listed := admin.mustDo(http.MethodGet, "/api/v1/products", nil, http.StatusOK)
	for _, raw := range listed["products"].([]any) {
		p := raw.(map[string]any)
		if str(p, "name") == name {
			return str(p, "id")
		}
	}
	t.Fatalf("no product called %q", name)
	return ""
}

// milkingAnimal puts one animal on the register and records what it gave
// today.
func milkingAnimal(t *testing.T, admin *client, tag string, morning, evening float64) string {
	t.Helper()
	animal := admin.mustDo(http.MethodPost, "/api/v1/animals",
		map[string]any{"tag": tag, "stage": "milking"}, http.StatusCreated)
	id := str(animal, "id")
	admin.mustDo(http.MethodPut, "/api/v1/animals/"+id+"/yield",
		map[string]any{"morning": morning, "evening": evening}, http.StatusOK)
	return id
}

// standingOrder gives a new customer a daily order and materialises today,
// so the round has something to need.
func standingOrder(t *testing.T, admin *client, name string, lines map[string]float64) {
	t.Helper()
	customer := createCustomer(t, admin, name, 17.05, 79.26)
	for productID, quantity := range lines {
		admin.mustDo(http.MethodPost, "/api/v1/recurring-orders", map[string]any{
			"customer_id": customer, "product_id": productID, "quantity": quantity,
			"frequency": "daily", "weekdays": []any{0, 1, 2, 3, 4, 5, 6},
		}, http.StatusCreated)
	}
	admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
}

// The herd is not the whole of a day's milk. A farm buys cans in when it
// is short and keeps some back for the house and for family, and a ledger
// that only knew the herd would be wrong both ways on an ordinary morning.
func TestMilkLedgerAddsBoughtInAndSubtractsKeptBack(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	milkingAnimal(t, admin, "A-12", 6, 4)
	admin.mustDo(http.MethodPost, "/api/v1/milk/adjustments",
		map[string]any{"litres": 5, "direction": "in", "note": "Ramesh"}, http.StatusCreated)
	admin.mustDo(http.MethodPost, "/api/v1/milk/adjustments",
		map[string]any{"litres": 2, "direction": "out", "note": "family"}, http.StatusCreated)

	ledger := admin.mustDo(http.MethodGet, "/api/v1/milk/day", nil, http.StatusOK)
	for field, want := range map[string]float64{
		"herd": 10, "bought_in": 5, "kept_back": 2, "available": 13,
	} {
		if got := num(ledger, field); got != want {
			t.Errorf("%s = %v, want %v", field, got, want)
		}
	}
	if list, _ := ledger["adjustments"].([]any); len(list) != 2 {
		t.Errorf("%d adjustments, want 2", len(list))
	}
}

// The round is measured in litres through the size in each product's
// name: three litre bottles and two half-litres is four litres.
func TestMilkLedgerMeasuresTheRoundInLitres(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	standingOrder(t, admin, "Mounika", map[string]float64{
		productIDByName(t, admin, "Milk 1L"):    3,
		productIDByName(t, admin, "Milk 500ml"): 2,
	})

	ledger := admin.mustDo(http.MethodGet, "/api/v1/milk/day", nil, http.StatusOK)
	if got := num(ledger, "needed"); got != 4 {
		t.Errorf("needed = %v, want 4", got)
	}
}

// A product with no volume in its name is not milk to the ledger. It is
// named rather than quietly left out, so nobody reads a total that is
// missing something without being told.
func TestUnmeasuredProductsAreNamedNotCounted(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	paneer := admin.mustDo(http.MethodPost, "/api/v1/products",
		map[string]any{"name": "Paneer 200g", "unit": "packet"}, http.StatusCreated)
	standingOrder(t, admin, "Anita", map[string]float64{
		str(paneer, "id"):                    1,
		productIDByName(t, admin, "Milk 1L"): 2,
	})

	ledger := admin.mustDo(http.MethodGet, "/api/v1/milk/day", nil, http.StatusOK)
	if got := num(ledger, "needed"); got != 2 {
		t.Errorf("needed = %v, want 2 — the paneer is not litres", got)
	}
	unmeasured, _ := ledger["unmeasured"].([]any)
	if len(unmeasured) != 1 || unmeasured[0] != "Paneer 200g" {
		t.Errorf("unmeasured = %v, want [Paneer 200g]", unmeasured)
	}
}

// One press turns the day's milk into the round's bottles, and says what
// is left over.
func TestBottlingFillsTheShelfFromTheDaysMilk(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	litre := productIDByName(t, admin, "Milk 1L")
	half := productIDByName(t, admin, "Milk 500ml")
	milkingAnimal(t, admin, "A-12", 6, 4)
	standingOrder(t, admin, "Mounika", map[string]float64{litre: 3, half: 2})

	result := admin.mustDo(http.MethodPost, "/api/v1/milk/bottle", map[string]any{}, http.StatusOK)
	if got := num(result, "left_over"); got != 6 {
		t.Errorf("left_over = %v, want 6 (10 L from the herd, 4 L needed)", got)
	}

	day := admin.mustDo(http.MethodGet, "/api/v1/products/demand", nil, http.StatusOK)
	stock := day["stock"].(map[string]any)
	if got := num(stock, litre); got != 3 {
		t.Errorf("Milk 1L stock = %v, want 3", got)
	}
	if got := num(stock, half); got != 2 {
		t.Errorf("Milk 500ml stock = %v, want 2", got)
	}
}

// Short of milk, it refuses rather than choosing. Filling some sizes and
// not others is deciding which customers go without, and that is the
// farm's decision, made with the ledger in front of it.
func TestBottlingRefusesWhenShortAndWritesNothing(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	litre := productIDByName(t, admin, "Milk 1L")
	milkingAnimal(t, admin, "A-12", 1, 1)
	standingOrder(t, admin, "Mounika", map[string]float64{litre: 4})

	body := admin.mustDo(http.MethodPost, "/api/v1/milk/bottle", map[string]any{}, http.StatusConflict)
	if code := str(body, "code"); code != "short" {
		t.Errorf("code = %q, want short", code)
	}

	day := admin.mustDo(http.MethodGet, "/api/v1/products/demand", nil, http.StatusOK)
	if stock, _ := day["stock"].(map[string]any); len(stock) != 0 {
		t.Errorf("stock = %v after a refused bottling, want nothing written", stock)
	}
}

// Bought-in milk counts towards bottling. That is the point of entering
// it: the herd alone was short, and the neighbour's cans are what cover
// the round.
func TestBoughtInMilkCanCoverAShortHerd(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	litre := productIDByName(t, admin, "Milk 1L")
	milkingAnimal(t, admin, "A-12", 1, 1)
	standingOrder(t, admin, "Mounika", map[string]float64{litre: 4})

	admin.mustDo(http.MethodPost, "/api/v1/milk/bottle", map[string]any{}, http.StatusConflict)
	admin.mustDo(http.MethodPost, "/api/v1/milk/adjustments",
		map[string]any{"litres": 3, "direction": "in", "note": "Ramesh"}, http.StatusCreated)
	admin.mustDo(http.MethodPost, "/api/v1/milk/bottle", map[string]any{}, http.StatusOK)
}

// A figure somebody typed is never lowered. The admin who bottled ten
// extra litre bottles for walk-in sales did that on purpose.
func TestBottlingNeverLowersAFigureSomebodyTyped(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	litre := productIDByName(t, admin, "Milk 1L")
	half := productIDByName(t, admin, "Milk 500ml")
	milkingAnimal(t, admin, "A-12", 10, 10)
	standingOrder(t, admin, "Mounika", map[string]float64{litre: 3, half: 2})

	admin.mustDo(http.MethodPut, "/api/v1/products/"+litre+"/stock",
		map[string]any{"quantity": 10}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/milk/bottle", map[string]any{}, http.StatusOK)

	day := admin.mustDo(http.MethodGet, "/api/v1/products/demand", nil, http.StatusOK)
	stock := day["stock"].(map[string]any)
	if got := num(stock, litre); got != 10 {
		t.Errorf("Milk 1L stock = %v, want the 10 somebody typed", got)
	}
	if got := num(stock, half); got != 2 {
		t.Errorf("Milk 500ml stock = %v, want 2 filled", got)
	}
}

// The boundaries a number box needs: nothing is not an amount, milk went
// one way or the other, and nobody moves ten thousand litres by hand.
func TestMilkAdjustmentsAreChecked(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	for _, body := range []map[string]any{
		{"litres": 0, "direction": "in"},
		{"litres": -3, "direction": "out"},
		{"litres": 4, "direction": "sideways"},
		{"litres": 20000, "direction": "in"},
		{"litres": 4, "direction": "in", "date": "yesterday"},
	} {
		admin.mustDo(http.MethodPost, "/api/v1/milk/adjustments", body, http.StatusBadRequest)
	}
}

// One farm's ledger is not another's to read or edit.
func TestMilkLedgerIsScopedToTheBusiness(t *testing.T) {
	server := newTestServer(t)
	first := adminClient(t, server)
	second := secondBusinessAdminClient(t, server)

	entry := first.mustDo(http.MethodPost, "/api/v1/milk/adjustments",
		map[string]any{"litres": 5, "direction": "in"}, http.StatusCreated)

	theirs := second.mustDo(http.MethodGet, "/api/v1/milk/day", nil, http.StatusOK)
	if got := num(theirs, "bought_in"); got != 0 {
		t.Errorf("the other farm sees %v L bought in, want 0", got)
	}
	second.mustDo(http.MethodDelete, "/api/v1/milk/adjustments/"+str(entry, "id"), nil, http.StatusNotFound)
}

// Milk from an animal under treatment was produced and cannot be sold. It
// is stated on its own and never counted as available — and the milking
// sheet must call exactly the same animal's milk discarded, or the two
// screens give two answers to "how much milk did we have".
func TestWithheldMilkIsNotAvailableAndAgreesWithTheMilkingSheet(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	milkingAnimal(t, admin, "A-12", 6, 4)
	treated := milkingAnimal(t, admin, "A-13", 3, 2)
	admin.mustDo(http.MethodPost, "/api/v1/animals/"+treated+"/health", map[string]any{
		"kind": "treatment", "name": "mastitis", "milk_withheld_until": "2099-12-31",
	}, http.StatusCreated)

	ledger := admin.mustDo(http.MethodGet, "/api/v1/milk/day", nil, http.StatusOK)
	if got := num(ledger, "herd"); got != 10 {
		t.Errorf("herd = %v, want 10 — the treated animal's milk cannot be sold", got)
	}
	if got := num(ledger, "withheld"); got != 5 {
		t.Errorf("withheld = %v, want 5", got)
	}
	if got := num(ledger, "available"); got != 10 {
		t.Errorf("available = %v, want 10", got)
	}

	sheet := admin.mustDo(http.MethodGet, "/api/v1/herd/day", nil, http.StatusOK)
	withheld, _ := sheet["withheld"].(map[string]any)
	if _, ok := withheld[treated]; !ok || len(withheld) != 1 {
		t.Errorf("milking sheet withholds %v, want exactly the treated animal", withheld)
	}
}

// A day's milk is that day's. An animal dried off since still gave the
// milk she gave, and a ledger for an earlier day must keep it.
func TestTheLedgerKeepsMilkFromAnAnimalDriedOffSince(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	id := milkingAnimal(t, admin, "A-12", 6, 4)
	admin.mustDo(http.MethodPatch, "/api/v1/animals/"+id, map[string]any{"stage": "dry"}, http.StatusOK)

	ledger := admin.mustDo(http.MethodGet, "/api/v1/milk/day", nil, http.StatusOK)
	if got := num(ledger, "herd"); got != 10 {
		t.Errorf("herd = %v, want 10 — she gave it before she was dried off", got)
	}
}
