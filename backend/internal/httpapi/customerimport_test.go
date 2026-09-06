package httpapi

import (
	"fmt"
	"net/http"
	"testing"
)

func importRows(rows ...map[string]any) []any {
	out := make([]any, 0, len(rows))
	for _, r := range rows {
		out = append(out, r)
	}
	return out
}

func verdicts(t *testing.T, body map[string]any) []string {
	t.Helper()
	raw, _ := body["results"].([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		row, _ := item.(map[string]any)
		out = append(out, str(row, "verdict"))
	}
	return out
}

// A dry run answers the question and changes nothing. That is the whole
// point of the preview: nobody should commit a file before finding out
// its product names match nothing.
func TestImportDryRunCreatesNothing(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	body := admin.mustDo(http.MethodPost, "/api/v1/customers/import", map[string]any{
		"dry_run": true,
		"rows": importRows(map[string]any{
			"name": "G Pavani", "phone": "7989457364", "lat": 17.0567, "lng": 79.2681,
		}),
	}, http.StatusOK)

	if got := verdicts(t, body); len(got) != 1 || got[0] != "new" {
		t.Errorf("dry run verdicts = %v, want [new]", got)
	}
	after := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	if list, _ := after["customers"].([]any); len(list) != 0 {
		t.Errorf("dry run created %d customers, want none", len(list))
	}
}

// Running the same file twice finishes the job rather than doubling it.
// Re-running is what someone actually does after a partial failure.
func TestImportSkipsCustomersAlreadyOnTheList(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	rows := importRows(map[string]any{
		"name": "G Pavani", "phone": "7989457364", "lat": 17.0567, "lng": 79.2681,
	})

	admin.mustDo(http.MethodPost, "/api/v1/customers/import",
		map[string]any{"rows": rows}, http.StatusOK)
	second := admin.mustDo(http.MethodPost, "/api/v1/customers/import",
		map[string]any{"rows": rows}, http.StatusOK)

	if got := verdicts(t, second); len(got) != 1 || got[0] != "duplicate" {
		t.Errorf("second run verdicts = %v, want [duplicate]", got)
	}
	after := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	if list, _ := after["customers"].([]any); len(list) != 1 {
		t.Errorf("after importing the same file twice there are %d customers, want 1", len(list))
	}
}

// Two people called Jyothi is commoner in a household list than one
// person entered twice, so the number is part of who somebody is.
func TestImportKeepsTwoPeopleWithTheSameName(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	admin.mustDo(http.MethodPost, "/api/v1/customers/import", map[string]any{
		"rows": importRows(
			map[string]any{"name": "Jyothi", "phone": "7981740198", "lat": 17.07, "lng": 79.26},
			map[string]any{"name": "Jyothi", "phone": "9490129156", "lat": 17.08, "lng": 79.27},
		),
	}, http.StatusOK)

	after := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	if list, _ := after["customers"].([]any); len(list) != 2 {
		t.Errorf("got %d customers, want both Jyothis", len(list))
	}
}

// "500 ML" in a dairy's size column means the product called "Milk
// 500ml" — the list only ever held one kind of milk, so it never wrote
// the word. Without loose matching every row of a real file needs an
// edit before it can be imported.
func TestImportMatchesAProductByItsSize(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	// A new dairy already sells Milk 500ml, 750ml and 1L — see
	// domain.dairyPreset. "500 ML" has to find the first of those on its
	// own, which is the whole point.
	body := admin.mustDo(http.MethodPost, "/api/v1/customers/import", map[string]any{
		"rows": importRows(map[string]any{
			"name": "G Pavani", "lat": 17.0567, "lng": 79.2681,
			"items": []any{map[string]any{"product": "500 ML", "quantity": 2}},
		}),
	}, http.StatusOK)

	if got := verdicts(t, body); len(got) != 1 || got[0] != "new" {
		t.Fatalf("verdicts = %v, want [new]", got)
	}
	orders := admin.mustDo(http.MethodGet, "/api/v1/recurring-orders", nil, http.StatusOK)
	list, _ := orders["recurring_orders"].([]any)
	if len(list) != 1 {
		t.Fatalf("got %d standing orders, want 1", len(list))
	}
	order, _ := list[0].(map[string]any)
	if num(order, "quantity") != 2 {
		t.Errorf("quantity = %v, want 2", num(order, "quantity"))
	}
	// No days in the file means every day.
	if got := int(num(order, "weekday_mask")); got != 127 {
		t.Errorf("weekday_mask = %d, want 127 (every day)", got)
	}
}

// A word that could mean two products means neither. Better to say so
// than to put curd on a milk round.
func TestImportRefusesAnAmbiguousProduct(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	admin.mustDo(http.MethodPost, "/api/v1/products",
		map[string]any{"name": "Curd 500ml", "unit": "packet"}, http.StatusCreated)

	// Now "500ml" could mean the milk or the curd.
	body := admin.mustDo(http.MethodPost, "/api/v1/customers/import", map[string]any{
		"dry_run": true,
		"rows": importRows(map[string]any{
			"name": "G Pavani", "lat": 17.0567, "lng": 79.2681,
			"items": []any{map[string]any{"product": "500ml", "quantity": 1}},
		}),
	}, http.StatusOK)

	if got := verdicts(t, body); len(got) != 1 || got[0] != "error" {
		t.Errorf("verdicts = %v, want [error] for a word matching two products", got)
	}
}

// One bad row does not stop the good ones. "Seven of thirty-four failed,
// here they are" beats "nothing happened, find out why".
func TestImportCarriesOnPastABadRow(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	body := admin.mustDo(http.MethodPost, "/api/v1/customers/import", map[string]any{
		"rows": importRows(
			map[string]any{"name": "G Pavani", "lat": 17.0567, "lng": 79.2681},
			map[string]any{"name": "", "lat": 17.06, "lng": 79.27},
			map[string]any{"name": "Md Imran", "lat": 17.05, "lng": 79.26},
		),
	}, http.StatusOK)

	want := []string{"new", "error", "new"}
	got := verdicts(t, body)
	for i := range want {
		if i >= len(got) || got[i] != want[i] {
			t.Fatalf("verdicts = %v, want %v", got, want)
		}
	}
	if num(body, "new") != 2 || num(body, "failed") != 1 {
		t.Errorf("counts new=%v failed=%v, want 2 and 1", num(body, "new"), num(body, "failed"))
	}
}

// A pin off the edge of the world is a typo, and it has to be caught
// before it becomes a stop nobody can drive to.
func TestImportRefusesAnImpossiblePin(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	body := admin.mustDo(http.MethodPost, "/api/v1/customers/import", map[string]any{
		"dry_run": true,
		"rows":    importRows(map[string]any{"name": "G Pavani", "lat": 917.05, "lng": 79.26}),
	}, http.StatusOK)

	if got := verdicts(t, body); len(got) != 1 || got[0] != "error" {
		t.Errorf("verdicts = %v, want [error]", got)
	}
}

// A real list writes "1 Lit" where the product is called "Milk 1L", and
// "1 1/2 Lit" where it is "Milk 1.5L". Matching by letters alone failed
// on every one of those rows the first time a real file went through the
// preview.
func TestImportMatchesHowSizesAreActuallyWritten(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	admin.mustDo(http.MethodPost, "/api/v1/products",
		map[string]any{"name": "Milk 1.5L", "unit": "packet"}, http.StatusCreated)

	for _, written := range []struct{ text, want string }{
		{"1 Lit", "Milk 1L"},
		{"1Lit", "Milk 1L"},
		{"1 litre", "Milk 1L"},
		{"1 ltr", "Milk 1L"},
		{"500 ML", "Milk 500ml"},
		{"500ml", "Milk 500ml"},
		{"750 ML", "Milk 750ml"},
		{"1 1/2 Lit", "Milk 1.5L"},
	} {
		body := admin.mustDo(http.MethodPost, "/api/v1/customers/import", map[string]any{
			"dry_run": true,
			"rows": importRows(map[string]any{
				"name": "Someone", "lat": 17.05, "lng": 79.26,
				"items": []any{map[string]any{"product": written.text, "quantity": 1}},
			}),
		}, http.StatusOK)

		results, _ := body["results"].([]any)
		row, _ := results[0].(map[string]any)
		matched, _ := row["matched"].([]any)
		if str(row, "verdict") != "new" || len(matched) != 1 {
			t.Errorf("%q: verdict %s, problem %q — want it to find %s",
				written.text, str(row, "verdict"), str(row, "problem"), written.want)
			continue
		}
		if got, _ := matched[0].(string); got != "1 × "+written.want {
			t.Errorf("%q matched %q, want %q", written.text, got, "1 × "+written.want)
		}
	}
}

// Millilitres must not be read as litres on the way through. "500 ML"
// ends in an l, and a careless replacement would turn it into "500 L".
func TestImportKeepsMillilitresApartFromLitres(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	body := admin.mustDo(http.MethodPost, "/api/v1/customers/import", map[string]any{
		"dry_run": true,
		"rows": importRows(map[string]any{
			"name": "Someone", "lat": 17.05, "lng": 79.26,
			"items": []any{map[string]any{"product": "500 ML", "quantity": 1}},
		}),
	}, http.StatusOK)

	results, _ := body["results"].([]any)
	row, _ := results[0].(map[string]any)
	matched, _ := row["matched"].([]any)
	if len(matched) != 1 {
		t.Fatalf("500 ML matched nothing: %q", str(row, "problem"))
	}
	if got, _ := matched[0].(string); got != "1 × Milk 500ml" {
		t.Errorf("500 ML matched %q, want the 500ml product", got)
	}
}

// A delivery list is numbered 1..N because somebody worked that round
// out, often years ago. Importing it as an unordered bag threw that away
// and the roster came back alphabetical, which is nobody's route.
func TestImportKeepsTheOrderTheFileIsIn(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	names := []string{"G Pavani", "Md Imran", "Rapolu hariprasad", "B Venu"}
	rows := make([]map[string]any, 0, len(names))
	for i, name := range names {
		rows = append(rows, map[string]any{
			"name": name, "phone": fmt.Sprintf("70000000%02d", i), "lat": 17.05 + float64(i)/1000, "lng": 79.26,
		})
	}
	admin.mustDo(http.MethodPost, "/api/v1/customers/import",
		map[string]any{"rows": importRows(rows...)}, http.StatusOK)

	body := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	list, _ := body["customers"].([]any)
	byRank := map[int]string{}
	for _, item := range list {
		c, _ := item.(map[string]any)
		byRank[int(num(c, "rank"))] = str(c, "name")
	}
	for i, name := range names {
		if got := byRank[i+1]; got != name {
			t.Errorf("rank %d is %q, want %q — the file's own order", i+1, got, name)
		}
	}
}

// A second import lands after the round that is already there, rather
// than interleaved through it.
func TestImportRanksATopUpAfterTheExistingRound(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	admin.mustDo(http.MethodPost, "/api/v1/customers/import", map[string]any{
		"rows": importRows(
			map[string]any{"name": "First", "phone": "7000000001", "lat": 17.05, "lng": 79.26},
			map[string]any{"name": "Second", "phone": "7000000002", "lat": 17.06, "lng": 79.26},
		),
	}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/customers/import", map[string]any{
		"rows": importRows(map[string]any{"name": "Later", "phone": "7000000003", "lat": 17.07, "lng": 79.26}),
	}, http.StatusOK)

	body := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	list, _ := body["customers"].([]any)
	for _, item := range list {
		c, _ := item.(map[string]any)
		if str(c, "name") == "Later" && int(num(c, "rank")) != 3 {
			t.Errorf("the later import got rank %d, want 3 — after the two already there", int(num(c, "rank")))
		}
	}
}

// A file that lists the same household twice says so in the preview.
// This was only tracked while actually importing, so the preview
// promised one more customer than the import made — the one number a
// preview exists to get right.
func TestImportPreviewCountsARepeatWithinTheFile(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	rows := importRows(
		map[string]any{"name": "M Kiran kumar", "phone": "9908646281", "lat": 17.05, "lng": 79.26},
		map[string]any{"name": "Someone else", "phone": "9160738912", "lat": 17.06, "lng": 79.26},
		// The same person, typed the way a hurried list types them.
		map[string]any{"name": "M kiran kumar", "phone": "9908646281", "lat": 17.05, "lng": 79.26},
	)

	preview := admin.mustDo(http.MethodPost, "/api/v1/customers/import",
		map[string]any{"dry_run": true, "rows": rows}, http.StatusOK)
	if got := verdicts(t, preview); len(got) != 3 || got[2] != "duplicate" {
		t.Errorf("preview verdicts = %v, want the third row to be a duplicate", got)
	}
	if num(preview, "new") != 2 {
		t.Errorf("preview said %v would be added, want 2", num(preview, "new"))
	}

	real := admin.mustDo(http.MethodPost, "/api/v1/customers/import",
		map[string]any{"rows": rows}, http.StatusOK)
	if num(real, "new") != num(preview, "new") {
		t.Errorf("import added %v but the preview promised %v", num(real, "new"), num(preview, "new"))
	}
}

// A file is usually one round — somebody's morning list — so importing
// it into that round is what the file means. It is also the only way a
// customer whose pin is missing can be on a round at all.
func TestImportPutsEveryRowOnTheChosenRoute(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	area := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Nalgonda Morning", "lat": 17.0500, "lng": 79.2670, "radius_meters": 8000,
	}, http.StatusCreated)

	admin.mustDo(http.MethodPost, "/api/v1/customers/import", map[string]any{
		"service_area_id": str(area, "id"),
		"rows": importRows(
			map[string]any{"name": "Has A Pin", "phone": "7000000001", "lat": 17.05, "lng": 79.26},
			// Miles outside the circle: the assignment wins over geography.
			map[string]any{"name": "Far Away", "phone": "7000000002", "lat": 12.97, "lng": 77.59},
			map[string]any{"name": "No Pin At All", "phone": "7000000003"},
		),
	}, http.StatusOK)

	body := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	list, _ := body["customers"].([]any)
	if len(list) != 3 {
		t.Fatalf("got %d customers, want 3", len(list))
	}
	for _, item := range list {
		c, _ := item.(map[string]any)
		if str(c, "service_area_id") != str(area, "id") {
			t.Errorf("%s was not put on the chosen route", str(c, "name"))
		}
	}
}

// A route id that is not this business's fails the whole import rather
// than half of it.
func TestImportRefusesAnUnknownRoute(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	admin.mustDo(http.MethodPost, "/api/v1/customers/import", map[string]any{
		"service_area_id": "not-a-real-route",
		"rows":            importRows(map[string]any{"name": "Someone", "phone": "7000000009"}),
	}, http.StatusNotFound)

	body := admin.mustDo(http.MethodGet, "/api/v1/customers", nil, http.StatusOK)
	if list, _ := body["customers"].([]any); len(list) != 0 {
		t.Errorf("a bad route id created %d customers, want none", len(list))
	}
}
