package httpapi

import (
	"context"
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

// A bull is never milking, and a cow is never a bull. These are not
// preferences a farm can hold differently — a male marked "milking"
// would carry a lactation record into every total on the sheet.
func TestSexAndStageHaveToAgree(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	admin.mustDo(http.MethodPost, "/api/v1/animals",
		map[string]any{"tag": "S1", "sex": "male", "stage": "milking"}, http.StatusBadRequest)
	admin.mustDo(http.MethodPost, "/api/v1/animals",
		map[string]any{"tag": "S2", "sex": "female", "stage": "bull"}, http.StatusBadRequest)

	// A new male with no stage given is corrected, not refused — the
	// default was picked before anyone knew the sex.
	bull := newAnimal(t, admin, "S3", map[string]any{"sex": "male"})
	if got := str(bull, "stage"); got != "calf" {
		t.Errorf("a male with no stage given is %q, want calf", got)
	}

	// And changing sex under a stage that no longer fits fails too.
	cow := newAnimal(t, admin, "S4", nil)
	admin.mustDo(http.MethodPatch, "/api/v1/animals/"+str(cow, "id"),
		map[string]any{"sex": "male"}, http.StatusBadRequest)
}

// Milk and crossings are recorded against the female. A bull has
// neither, and letting one through corrupts the day's totals.
func TestAMaleAnimalHasNoMilkAndNoCrossings(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "M1", map[string]any{"sex": "male", "stage": "bull"}), "id")

	admin.mustDo(http.MethodPut, "/api/v1/animals/"+id+"/yield",
		map[string]any{"date": "2026-01-01", "morning": 5}, http.StatusBadRequest)
	admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/breedings",
		map[string]any{"crossed_on": "2026-01-01"}, http.StatusBadRequest)
}

// A business with no herd has no herd endpoints. Hiding the tab is not
// enough on its own — a school bus operator with eleven live animal
// routes would have a table quietly filling with records nobody can
// explain.
func TestABusinessWithoutAHerdHasNoHerdEndpoints(t *testing.T) {
	server := newTestServer(t)

	_, admin, err := server.createBusinessWithAdmin(context.Background(),
		"A School", domain.BusinessTypeSchool, "UTC", "school-admin@example.com", "School Admin")
	if err != nil {
		t.Fatalf("create school business: %v", err)
	}
	token, err := server.auth.IssueToken(admin)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	school := &client{t: t, server: server, token: token}

	school.mustDo(http.MethodGet, "/api/v1/animals", nil, http.StatusNotFound)
	school.mustDo(http.MethodPost, "/api/v1/animals", map[string]any{"tag": "X1"}, http.StatusNotFound)
	school.mustDo(http.MethodGet, "/api/v1/herd/day", nil, http.StatusNotFound)
	school.mustDo(http.MethodGet, "/api/v1/herd/alerts", nil, http.StatusNotFound)

	// And the dairy alongside it is unaffected.
	adminClient(t, server).mustDo(http.MethodGet, "/api/v1/animals", nil, http.StatusOK)
}

// setYield is a small helper: five recorded days build the baseline an
// alert is judged against, so most of these tests spend most of their
// setup writing ordinary milk records before the one that matters.
func setYield(t *testing.T, admin *client, animalID, date string, morning, evening float64) {
	t.Helper()
	admin.mustDo(http.MethodPut, "/api/v1/animals/"+animalID+"/yield",
		map[string]any{"date": date, "morning": morning, "evening": evening}, http.StatusOK)
}

func openAlerts(t *testing.T, admin *client) []any {
	t.Helper()
	body := admin.mustDo(http.MethodGet, "/api/v1/herd/alerts", nil, http.StatusOK)
	list, _ := body["alerts"].([]any)
	return list
}

// A cow that has been giving ten litres a day and gives seven is the
// warning a farmer already reads by eye — this is that same reading,
// automated. Five ordinary days establish what "ten litres" means for
// this particular animal before the drop is judged against it.
func TestAYieldFarBelowItsOwnBaselineRaisesAnAlert(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "Y1", nil), "id")

	dates := []string{"2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"}
	for _, date := range dates {
		setYield(t, admin, id, date, 5, 5) // 10L/day baseline
	}
	setYield(t, admin, id, "2026-01-06", 4, 3) // 7L — a 30% drop

	alerts := openAlerts(t, admin)
	if len(alerts) != 1 {
		t.Fatalf("%d open alerts, want 1", len(alerts))
	}
	alert := alerts[0].(map[string]any)
	if str(alert, "animal_id") != id {
		t.Errorf("alert is for animal %q, want %q", str(alert, "animal_id"), id)
	}
	if str(alert, "kind") != "yield_drop" {
		t.Errorf("kind = %q, want yield_drop", str(alert, "kind"))
	}
	if num(alert, "baseline") != 10 {
		t.Errorf("baseline = %v, want 10", num(alert, "baseline"))
	}
	if num(alert, "actual") != 7 {
		t.Errorf("actual = %v, want 7", num(alert, "actual"))
	}
	if str(alert, "status") != "open" {
		t.Errorf("status = %q, want open", str(alert, "status"))
	}
}

// A freshly registered animal has no history to fall below yet — its
// first low day is the only data point there is, not a drop.
func TestNoBaselineMeansNoAlert(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "Y2", nil), "id")

	// Two days of history is short of the five needed to trust a baseline.
	setYield(t, admin, id, "2026-01-01", 5, 5)
	setYield(t, admin, id, "2026-01-02", 5, 5)
	setYield(t, admin, id, "2026-01-03", 1, 1)

	if alerts := openAlerts(t, admin); len(alerts) != 0 {
		t.Errorf("%d alerts with only two days of history, want 0", len(alerts))
	}
}

// Day-to-day wobble is not a warning. Ten litres yesterday and nine
// today is normal, and an app that flagged it would train a farmer to
// ignore the tab entirely.
func TestAnOrdinaryDipDoesNotRaiseAnAlert(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "Y3", nil), "id")

	for _, date := range []string{"2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"} {
		setYield(t, admin, id, date, 5, 5)
	}
	setYield(t, admin, id, "2026-01-06", 4.5, 4.5) // 9L — a 10% dip

	if alerts := openAlerts(t, admin); len(alerts) != 0 {
		t.Errorf("%d alerts for a 10%% dip, want 0", len(alerts))
	}
}

// A drop that continues for a week is one problem, not seven — the
// second and third low day must not each add their own alert on top of
// the one already waiting for an answer.
func TestASustainedDropStaysOneAlert(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "Y4", nil), "id")

	for _, date := range []string{"2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"} {
		setYield(t, admin, id, date, 5, 5)
	}
	setYield(t, admin, id, "2026-01-06", 3, 3)
	setYield(t, admin, id, "2026-01-07", 3, 3)

	if alerts := openAlerts(t, admin); len(alerts) != 1 {
		t.Errorf("%d open alerts after two low days in a row, want 1", len(alerts))
	}
}

// Resolving an alert is where the farmer's own diagnosis goes — the app
// never guesses one — and a resolved alert leaves the open list, the
// same way a delivered stop leaves today's board.
func TestResolvingAnAlertClearsItAndKeepsTheNote(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "Y5", nil), "id")

	for _, date := range []string{"2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"} {
		setYield(t, admin, id, date, 5, 5)
	}
	setYield(t, admin, id, "2026-01-06", 3, 3)

	alerts := openAlerts(t, admin)
	if len(alerts) != 1 {
		t.Fatalf("%d open alerts, want 1", len(alerts))
	}
	alertID := str(alerts[0].(map[string]any), "id")

	resolved := admin.mustDo(http.MethodPatch, "/api/v1/herd/alerts/"+alertID,
		map[string]any{"status": "resolved", "note": "mastitis, treated, back to normal by the 10th"}, http.StatusOK)
	if str(resolved, "status") != "resolved" {
		t.Errorf("status = %q, want resolved", str(resolved, "status"))
	}
	if str(resolved, "note") == "" {
		t.Error("note was dropped on resolve")
	}
	if str(resolved, "resolved_on") == "" {
		t.Error("resolved_on was not set")
	}

	if alerts := openAlerts(t, admin); len(alerts) != 0 {
		t.Errorf("%d alerts still open after resolving, want 0", len(alerts))
	}
}

// An unknown status is rejected rather than silently accepted — same
// closed-set reasoning as an animal's stage or a crossing's result.
func TestAnAlertNeedsAStatusThisAppKnows(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "Y6", nil), "id")

	for _, date := range []string{"2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"} {
		setYield(t, admin, id, date, 5, 5)
	}
	setYield(t, admin, id, "2026-01-06", 3, 3)

	alertID := str(openAlerts(t, admin)[0].(map[string]any), "id")
	admin.mustDo(http.MethodPatch, "/api/v1/herd/alerts/"+alertID,
		map[string]any{"status": "ignored"}, http.StatusBadRequest)
}

// Another farm's alerts are not visible, same as its animals.
func TestAlertsAreScopedToTheBusiness(t *testing.T) {
	server := newTestServer(t)
	first := adminClient(t, server)
	second := secondBusinessAdminClient(t, server)
	id := str(newAnimal(t, first, "Y7", nil), "id")

	for _, date := range []string{"2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"} {
		setYield(t, first, id, date, 5, 5)
	}
	setYield(t, first, id, "2026-01-06", 3, 3)

	if alerts := openAlerts(t, first); len(alerts) != 1 {
		t.Fatalf("%d alerts on the first business, want 1", len(alerts))
	}
	if alerts := openAlerts(t, second); len(alerts) != 0 {
		t.Errorf("%d alerts visible to the other business, want 0", len(alerts))
	}
}

// ---------- the health book ----------

// FMD comes round every six months in India, HS and BQ annually. Nobody
// remembers that per animal across forty of them, so recording the jab
// schedules the next one — without anybody doing arithmetic in a shed.
func TestAVaccinationSchedulesItsOwnNextDose(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "H1", nil), "id")

	fmd := admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/health",
		map[string]any{"kind": "vaccination", "name": "FMD", "date": "2026-01-10"}, http.StatusCreated)
	if got, want := str(fmd, "next_due_on"), "2026-07-11"; got != want {
		t.Errorf("FMD next due %q, want %q (six months)", got, want)
	}

	hs := admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/health",
		map[string]any{"kind": "vaccination", "name": "HS", "date": "2026-01-10"}, http.StatusCreated)
	if got, want := str(hs, "next_due_on"), "2027-01-10"; got != want {
		t.Errorf("HS next due %q, want %q (annual)", got, want)
	}

	// A vet who says otherwise wins: an explicit date is never overwritten.
	own := admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/health",
		map[string]any{"kind": "vaccination", "name": "FMD", "date": "2026-02-01", "next_due_on": "2026-05-01"},
		http.StatusCreated)
	if got := str(own, "next_due_on"); got != "2026-05-01" {
		t.Errorf("next due %q overrode the vet's own date", got)
	}

	// And a name with no usual interval schedules nothing rather than
	// inventing one.
	odd := admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/health",
		map[string]any{"kind": "treatment", "name": "sprained hock", "date": "2026-02-01"}, http.StatusCreated)
	if got := str(odd, "next_due_on"); got != "" {
		t.Errorf("next due %q for a one-off treatment, want none", got)
	}
}

// Milk from a treated animal must not reach the churn. The sheet the
// milk is typed into is the only place that warning is any use.
func TestTreatedMilkIsFlaggedOnTheDayItIsWithheld(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	animal := newAnimal(t, admin, "H2", nil)
	id := str(animal, "id")

	admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/health", map[string]any{
		"kind": "treatment", "name": "mastitis", "date": "2026-09-01",
		"milk_withheld_until": "2026-09-04",
	}, http.StatusCreated)

	// Inside the window the sheet says so.
	day := admin.mustDo(http.MethodGet, "/api/v1/herd/day?date=2026-09-03", nil, http.StatusOK)
	withheld, _ := day["withheld"].(map[string]any)
	entry, ok := withheld[id].(map[string]any)
	if !ok {
		t.Fatalf("no withholding on 3 Sep, want one: %v", withheld)
	}
	if str(entry, "reason") != "mastitis" {
		t.Errorf("reason = %q, want mastitis", str(entry, "reason"))
	}

	// The last day is inclusive — milk on the 4th still goes out.
	last := admin.mustDo(http.MethodGet, "/api/v1/herd/day?date=2026-09-04", nil, http.StatusOK)
	if w, _ := last["withheld"].(map[string]any); len(w) != 1 {
		t.Errorf("withholding on the last day = %v, want it still held", w)
	}

	// And the day after, she is back in the churn.
	after := admin.mustDo(http.MethodGet, "/api/v1/herd/day?date=2026-09-05", nil, http.StatusOK)
	if w, _ := after["withheld"].(map[string]any); len(w) != 0 {
		t.Errorf("still withholding on 5 Sep = %v, want clear", w)
	}
}

// A jab falling due is a fact about the last one, not a notice to be
// dismissed — so giving the next dose is what clears it.
func TestGivingTheNextDoseClearsWhatIsDue(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "H3", nil), "id")

	admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/health",
		map[string]any{"kind": "vaccination", "name": "FMD", "date": "2020-01-01"}, http.StatusCreated)

	body := admin.mustDo(http.MethodGet, "/api/v1/herd/health-due", nil, http.StatusOK)
	due, _ := body["due"].([]any)
	if len(due) != 1 {
		t.Fatalf("%d due, want 1", len(due))
	}
	if first := due[0].(map[string]any); first["overdue"] != true {
		t.Errorf("a 2020 FMD is not marked overdue: %v", first)
	}

	// Give it again today; the next one is six months out, so nothing
	// is due now.
	admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/health",
		map[string]any{"kind": "vaccination", "name": "FMD"}, http.StatusCreated)
	after := admin.mustDo(http.MethodGet, "/api/v1/herd/health-due", nil, http.StatusOK)
	if list, _ := after["due"].([]any); len(list) != 0 {
		t.Errorf("%d still due after re-vaccinating, want 0", len(list))
	}
}

// The detector only knows what the milk says. Somebody in the shed can
// see a limp a day earlier, and needs somewhere to put it.
func TestAFarmerCanRaiseTheirOwnAlert(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "H4", nil), "id")

	admin.mustDo(http.MethodPost, "/api/v1/herd/alerts",
		map[string]any{"animal_id": id}, http.StatusBadRequest)

	created := admin.mustDo(http.MethodPost, "/api/v1/herd/alerts",
		map[string]any{"animal_id": id, "note": "limping on the near hind"}, http.StatusCreated)
	if str(created, "kind") != "manual" {
		t.Errorf("kind = %q, want manual", str(created, "kind"))
	}

	alerts := openAlerts(t, admin)
	if len(alerts) != 1 {
		t.Fatalf("%d open alerts, want 1", len(alerts))
	}
	// And it resolves through the same door as an automatic one.
	admin.mustDo(http.MethodPatch, "/api/v1/herd/alerts/"+str(created, "id"),
		map[string]any{"status": "resolved", "note": "vet saw it, abscess drained"}, http.StatusOK)
	if left := openAlerts(t, admin); len(left) != 0 {
		t.Errorf("%d alerts left open, want 0", len(left))
	}
}

// The right threshold is a property of the herd, not of this app: a
// steady farm wants to hear about 15%, a swingy one would be buried.
func TestTheMilkDropThresholdIsConfigurable(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "H5", nil), "id")

	// The config endpoint replaces the whole document, so the herd flag
	// has to be sent along with the threshold or the tenant loses it.
	admin.mustDo(http.MethodPut, "/api/v1/config", map[string]any{
		"config": map[string]any{"herd": true, "yield_drop_percent": 10},
	}, http.StatusOK)

	for _, date := range []string{"2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"} {
		setYield(t, admin, id, date, 5, 5)
	}
	// 12% down: under the default 20%, over this farm's 10%.
	setYield(t, admin, id, "2026-01-06", 4.4, 4.4)

	if alerts := openAlerts(t, admin); len(alerts) != 1 {
		t.Errorf("%d alerts for a 12%% drop at a 10%% threshold, want 1", len(alerts))
	}
}

// Every animal's own average, in one request rather than one per animal.
func TestTheSheetCarriesEachAnimalsOwnAverage(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "H6", nil), "id")

	setYield(t, admin, id, "2026-01-01", 6, 4)
	setYield(t, admin, id, "2026-01-02", 4, 6)

	day := admin.mustDo(http.MethodGet, "/api/v1/herd/day?date=2026-01-03", nil, http.StatusOK)
	averages, _ := day["averages"].(map[string]any)
	mine, ok := averages[id].(map[string]any)
	if !ok {
		t.Fatalf("no average for the animal: %v", averages)
	}
	if got := num(mine, "morning"); got != 5 {
		t.Errorf("morning average = %v, want 5", got)
	}
	if got := num(mine, "total"); got != 10 {
		t.Errorf("total average = %v, want 10", got)
	}
	if got := num(mine, "days"); got != 2 {
		t.Errorf("days = %v, want 2 — a day nobody recorded is not a zero", got)
	}
}

// A cow sold in June does not need her FMD booster. A due list that
// fills with animals who left is one somebody learns to ignore.
func TestASoldAnimalStopsAskingForJabs(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "X1", nil), "id")

	admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/health",
		map[string]any{"kind": "vaccination", "name": "FMD", "date": "2020-01-01"}, http.StatusCreated)
	if body := admin.mustDo(http.MethodGet, "/api/v1/herd/health-due", nil, http.StatusOK); len(body["due"].([]any)) != 1 {
		t.Fatal("an overdue FMD should be listed while she is on the farm")
	}

	admin.mustDo(http.MethodPatch, "/api/v1/animals/"+id, map[string]any{"stage": "sold"}, http.StatusOK)
	body := admin.mustDo(http.MethodGet, "/api/v1/herd/health-due", nil, http.StatusOK)
	if due, _ := body["due"].([]any); len(due) != 0 {
		t.Errorf("%d due for a sold animal, want 0", len(due))
	}
}

// A cow under treatment milks badly and everybody knows why — somebody
// wrote the treatment down an hour ago. Alerting fires hardest exactly
// when the herd is least healthy, which teaches people to ignore it.
func TestNoDropAlertWhileHerMilkIsBeingWithheld(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := str(newAnimal(t, admin, "X2", nil), "id")

	for _, date := range []string{"2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"} {
		setYield(t, admin, id, date, 5, 5)
	}
	admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/health", map[string]any{
		"kind": "treatment", "name": "mastitis", "date": "2026-01-06",
		"milk_withheld_until": "2026-01-09",
	}, http.StatusCreated)

	setYield(t, admin, id, "2026-01-06", 1, 1) // 80% down, and expected
	if alerts := openAlerts(t, admin); len(alerts) != 0 {
		t.Errorf("%d alerts for a cow under treatment, want 0", len(alerts))
	}

	// Once the withdrawal is over, she is news again.
	setYield(t, admin, id, "2026-01-10", 1, 1)
	if alerts := openAlerts(t, admin); len(alerts) != 1 {
		t.Errorf("%d alerts after the withdrawal ended, want 1", len(alerts))
	}
}

// Calving is the one moment the app knows for certain an animal is about
// to start milking. Leaving her dry means she is missing from tomorrow's
// sheet, and milk nobody is prompted to record goes unrecorded.
func TestCalvingBringsHerBackToMilking(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	for _, tc := range []struct{ tag, stage string }{{"X3", "dry"}, {"X4", "heifer"}} {
		id := str(newAnimal(t, admin, tc.tag, map[string]any{"stage": tc.stage}), "id")
		cross := admin.mustDo(http.MethodPost, "/api/v1/animals/"+id+"/breedings",
			map[string]any{"crossed_on": "2026-01-01"}, http.StatusCreated)

		out := admin.mustDo(http.MethodPatch, "/api/v1/breedings/"+str(cross, "id"),
			map[string]any{"calved_on": "2026-11-01"}, http.StatusOK)
		if out["freshened"] != true {
			t.Errorf("%s: calving did not report freshening", tc.tag)
		}

		listed := admin.mustDo(http.MethodGet, "/api/v1/animals", nil, http.StatusOK)
		for _, raw := range listed["animals"].([]any) {
			a := raw.(map[string]any)
			if str(a, "tag") == tc.tag && str(a, "stage") != "milking" {
				t.Errorf("%s was %s and is %q after calving, want milking", tc.tag, tc.stage, str(a, "stage"))
			}
		}
	}
}

// The vet comes on a Tuesday and does the whole farm. Recording that one
// animal at a time is why herd books stop being kept.
func TestTheWholeHerdIsVaccinatedInOneGo(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	for _, tag := range []string{"V1", "V2", "V3"} {
		newAnimal(t, admin, tag, nil)
	}
	gone := str(newAnimal(t, admin, "V4", nil), "id")
	admin.mustDo(http.MethodPatch, "/api/v1/animals/"+gone, map[string]any{"stage": "sold"}, http.StatusOK)

	round := admin.mustDo(http.MethodPost, "/api/v1/herd/vaccinate",
		map[string]any{"name": "FMD", "date": "2026-03-01", "vet": "Dr Rao", "batch": "B-1"}, http.StatusCreated)
	if got := num(round, "count"); got != 3 {
		t.Errorf("vaccinated %v animals, want 3 — the sold one is not on the farm", got)
	}
	if got, want := str(round, "next_due_on"), "2026-08-30"; got != want {
		t.Errorf("next due %q, want %q (six months)", got, want)
	}

	// Pressing it twice does not double-jab anybody.
	again := admin.mustDo(http.MethodPost, "/api/v1/herd/vaccinate",
		map[string]any{"name": "FMD", "date": "2026-03-01"}, http.StatusCreated)
	if num(again, "count") != 0 || num(again, "skipped") != 3 {
		t.Errorf("second round gave %v and skipped %v, want 0 and 3", num(again, "count"), num(again, "skipped"))
	}
}

// "How much did we make this month" is the question a dairy owner
// actually asks, and milk under a withdrawal is not part of the answer.
func TestTheMonthsProductionSeparatesWhatCannotBeSold(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	good := str(newAnimal(t, admin, "P1", nil), "id")
	sick := str(newAnimal(t, admin, "P2", nil), "id")

	setYield(t, admin, good, "2026-02-01", 5, 5)
	setYield(t, admin, good, "2026-02-02", 5, 5)
	admin.mustDo(http.MethodPost, "/api/v1/animals/"+sick+"/health", map[string]any{
		"kind": "treatment", "name": "mastitis", "date": "2026-02-01",
		"milk_withheld_until": "2026-02-02",
	}, http.StatusCreated)
	setYield(t, admin, sick, "2026-02-01", 3, 3)
	setYield(t, admin, sick, "2026-02-02", 3, 3)

	body := admin.mustDo(http.MethodGet, "/api/v1/herd/summary?from=2026-02-01&to=2026-02-28", nil, http.StatusOK)
	totals := body["totals"].(map[string]any)
	if got := num(totals, "total"); got != 20 {
		t.Errorf("sellable total = %v, want 20", got)
	}
	if got := num(totals, "discarded"); got != 12 {
		t.Errorf("discarded = %v, want 12", got)
	}
	if got := num(totals, "days_recorded"); got != 2 {
		t.Errorf("days recorded = %v, want 2", got)
	}
	if days, _ := body["days"].([]any); len(days) != 2 {
		t.Errorf("%d day rows, want 2", len(days))
	}
	// And the league table names who carried it.
	top, _ := body["top"].([]any)
	if len(top) == 0 || str(top[0].(map[string]any), "animal_tag") != "P1" {
		t.Errorf("top animal = %v, want P1", top)
	}
}

// A range that starts after it ends is a typo, not an empty month.
func TestABackwardsRangeIsRefused(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	admin.mustDo(http.MethodGet, "/api/v1/herd/summary?from=2026-03-01&to=2026-02-01", nil, http.StatusBadRequest)
}
