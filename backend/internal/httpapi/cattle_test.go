package httpapi

import (
	"net/http"
	"testing"
	"time"

	"delivery-manager/internal/domain"
)

func newAnimal(t *testing.T, admin *client, tag string, extra map[string]any) map[string]any {
	t.Helper()
	body := map[string]any{"tag": tag}
	for k, v := range extra {
		body[k] = v
	}
	return admin.mustDo(http.MethodPost, "/api/v1/animals", body, http.StatusCreated)
}

// The tag is the animal. A farm writes the same one three ways across a
// year of notebooks, and entering it twice must be caught rather than
// producing a second buffalo that does not exist.
func TestTheSameTagSpelledDifferentlyIsTheSameAnimal(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	newAnimal(t, admin, "A-12", nil)
	admin.mustDo(http.MethodPost, "/api/v1/animals", map[string]any{"tag": "a 12"}, http.StatusConflict)

	listed := admin.mustDo(http.MethodGet, "/api/v1/animals", nil, http.StatusOK)
	if list, _ := listed["animals"].([]any); len(list) != 1 {
		t.Fatalf("%d animals, want 1", len(list))
	}
}

// A tag is required and everything else is not. A farm entering thirty
// buffaloes on a Tuesday knows the tags and may not know a birthdate for
// the ones it bought.
func TestAnAnimalNeedsOnlyItsTag(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	admin.mustDo(http.MethodPost, "/api/v1/animals", map[string]any{"tag": "  "}, http.StatusBadRequest)

	animal := newAnimal(t, admin, "77", nil)
	if str(animal, "species") != "buffalo" {
		t.Errorf("species = %q, want buffalo by default", str(animal, "species"))
	}
	if str(animal, "stage") != "milking" {
		t.Errorf("stage = %q, want milking by default", str(animal, "stage"))
	}
}

// A crossing carries a due date worked out from the species: a buffalo
// carries about ten and a half months, a cow about nine and a half. A
// date a month out is worse than none, which is why species is a field
// rather than being guessed from the breed.
func TestDueDateFollowsTheSpecies(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	buffalo := newAnimal(t, admin, "B1", map[string]any{"species": "buffalo"})
	cow := newAnimal(t, admin, "C1", map[string]any{"species": "cow"})

	for _, animal := range []map[string]any{buffalo, cow} {
		admin.mustDo(http.MethodPost, "/api/v1/animals/"+str(animal, "id")+"/breedings",
			map[string]any{"crossed_on": "2026-01-01", "method": "ai", "sire": "Murrah 44"}, http.StatusCreated)
	}

	want := map[string]string{
		str(buffalo, "id"): time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, 310).Format(domain.DateLayout),
		str(cow, "id"):     time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, 283).Format(domain.DateLayout),
	}
	for id, due := range want {
		body := admin.mustDo(http.MethodGet, "/api/v1/animals/"+id+"/breedings", nil, http.StatusOK)
		got := str(body["breedings"].([]any)[0].(map[string]any), "due_on")
		if got != due {
			t.Errorf("due_on = %q, want %q", got, due)
		}
	}
}

// A crossing that came to nothing is not a due date any more, and one
// that produced a calf is a fact rather than an expectation.
func TestOnlyALiveCrossingHasADueDate(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	animal := newAnimal(t, admin, "B2", nil)
	id := str(animal, "id")

	created := admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/breedings",
		map[string]any{"crossed_on": "2026-01-01"}, http.StatusCreated)
	if str(created, "due_on") == "" {
		t.Fatal("a pending crossing should have a due date")
	}

	empty := admin.mustDo(http.MethodPatch, "/api/v1/breedings/"+str(created, "id"),
		map[string]any{"result": "empty"}, http.StatusOK)
	if got := str(empty, "due_on"); got != "" {
		t.Errorf("due_on = %q for a crossing that came back empty, want none", got)
	}

	// And a calving date settles the result on its own — a calved
	// crossing left marked "pending" would sit in the due list forever.
	second := admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/breedings",
		map[string]any{"crossed_on": "2026-02-01"}, http.StatusCreated)
	calved := admin.mustDo(http.MethodPatch, "/api/v1/breedings/"+str(second, "id"),
		map[string]any{"calved_on": "2026-12-08"}, http.StatusOK)
	if str(calved, "result") != "calved" {
		t.Errorf("result = %q after a calving date, want calved", str(calved, "result"))
	}
	if got := str(calved, "due_on"); got != "" {
		t.Errorf("due_on = %q after calving, want none", got)
	}
}

// Morning and evening are entered hours apart by whoever milked. The
// evening figure must not wipe the morning's just by being the only
// field in the request.
func TestEveningMilkDoesNotEraseTheMorning(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "B3", nil), "id")

	admin.mustDo(http.MethodPut, "/api/v1/animals/"+id+"/yield",
		map[string]any{"date": "2026-09-08", "morning": 6.5}, http.StatusOK)
	after := admin.mustDo(http.MethodPut, "/api/v1/animals/"+id+"/yield",
		map[string]any{"date": "2026-09-08", "evening": 5}, http.StatusOK)

	if num(after, "morning") != 6.5 {
		t.Errorf("morning = %v after writing the evening, want 6.5", num(after, "morning"))
	}
	if num(after, "evening") != 5 {
		t.Errorf("evening = %v, want 5", num(after, "evening"))
	}
}

// Milk belongs to a day, like stock does. Yesterday's is not today's.
func TestMilkIsPerDay(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "B4", nil), "id")

	admin.mustDo(http.MethodPut, "/api/v1/animals/"+id+"/yield",
		map[string]any{"date": "2026-09-08", "morning": 6, "evening": 4}, http.StatusOK)

	day := admin.mustDo(http.MethodGet, "/api/v1/herd/day?date=2026-09-08", nil, http.StatusOK)
	yields := day["yields"].(map[string]any)
	if got := num(yields[id].(map[string]any), "morning"); got != 6 {
		t.Errorf("morning = %v, want 6", got)
	}

	next := admin.mustDo(http.MethodGet, "/api/v1/herd/day?date=2026-09-09", nil, http.StatusOK)
	if yields, _ := next["yields"].(map[string]any); len(yields) != 0 {
		t.Errorf("yields on the next day = %v, want nothing", yields)
	}
}

// An animal served twice — a failed check, then served again — has two
// crossings, and only the later one is what it is due from.
func TestTheDueDateIsTheLatestCrossing(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "B5", map[string]any{"species": "cow"}), "id")

	first := admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/breedings",
		map[string]any{"crossed_on": "2026-01-01"}, http.StatusCreated)
	admin.mustDo(http.MethodPatch, "/api/v1/breedings/"+str(first, "id"),
		map[string]any{"result": "empty"}, http.StatusOK)
	admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/breedings",
		map[string]any{"crossed_on": "2026-03-01"}, http.StatusCreated)

	day := admin.mustDo(http.MethodGet, "/api/v1/herd/day", nil, http.StatusOK)
	due := day["due"].(map[string]any)
	want := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, 283).Format(domain.DateLayout)
	if got, _ := due[id].(string); got != want {
		t.Errorf("due = %q, want %q — the later crossing is the live one", got, want)
	}
}

// Another farm's animals are not visible and not editable.
func TestAnimalsAreScopedToTheBusiness(t *testing.T) {
	server := newTestServer(t)
	first := adminClient(t, server)
	second := secondBusinessAdminClient(t, server)

	id := str(newAnimal(t, first, "B6", nil), "id")

	listed := second.mustDo(http.MethodGet, "/api/v1/animals", nil, http.StatusOK)
	if list, _ := listed["animals"].([]any); len(list) != 0 {
		t.Errorf("the other business sees %d animals, want 0", len(list))
	}
	second.mustDo(http.MethodPatch, "/api/v1/animals/"+id, map[string]any{"name": "theirs"}, http.StatusNotFound)
	second.mustDo(http.MethodPut, "/api/v1/animals/"+id+"/yield",
		map[string]any{"morning": 5}, http.StatusNotFound)

	// And the same tag on two farms is two different animals.
	newAnimal(t, second, "B6", nil)
}

// Deleting is behind the same window as every other delete, and selling
// an animal is a stage rather than a deletion.
func TestDeletingAnAnimalNeedsTheWindowOpen(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "B7", nil), "id")

	admin.mustDo(http.MethodDelete, "/api/v1/animals/"+id, nil, http.StatusForbidden)

	admin.mustDo(http.MethodPost, "/api/v1/account/delete-mode", map[string]any{"hours": 1}, http.StatusOK)
	admin.mustDo(http.MethodDelete, "/api/v1/animals/"+id, nil, http.StatusOK)

	listed := admin.mustDo(http.MethodGet, "/api/v1/animals", nil, http.StatusOK)
	if list, _ := listed["animals"].([]any); len(list) != 0 {
		t.Errorf("%d animals left, want 0", len(list))
	}
}
