package httpapi

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"delivery-manager/internal/domain"
	"delivery-manager/internal/storage"
)

// The herd: the animals, their crossings, and what each one gave.
//
// A dairy's other book. The delivery side of this app answers "what goes
// out"; this answers "what comes in, and from which animal" — and the
// two meet at a tag number, because that is what a farmer says out loud
// when something is wrong with a buffalo.
//
// Three things are kept, and they are deliberately three rather than one
// wide record:
//
//   - The animal. Its tag, and the handful of facts that do not change.
//   - Its crossings. A log, because an animal is served many times and
//     last year's service is how anybody works out whether this one is
//     late.
//   - Its milk, per day, morning and evening. A separate row per day, so
//     a year of records is a year of records rather than a number that
//     was overwritten every morning — the same lesson product stock
//     taught this app already.

func (s *Server) handleListAnimals(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	animals, err := s.store.ListAnimals(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "animals")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"animals": animals})
}

type animalRequest struct {
	Tag       string `json:"tag"`
	Name      string `json:"name"`
	Species   string `json:"species"`
	Breed     string `json:"breed"`
	Sex       string `json:"sex"`
	BornOn    string `json:"born_on"`
	ArrivedOn string `json:"arrived_on"`
	Source    string `json:"source"`
	Stage     string `json:"stage"`
	Notes     string `json:"notes"`
	Active    *bool  `json:"active"`
}

// applyTo folds a request onto an animal, returning why it cannot be.
//
// Everything except the tag is optional and stays optional. A farm
// entering thirty buffaloes on a Tuesday evening knows the tags and may
// not know a birthdate for the ones it bought; refusing the record until
// it does means the register never gets started.
func (req animalRequest) applyTo(a *domain.Animal, isNew bool) string {
	if tag := strings.TrimSpace(req.Tag); tag != "" {
		a.Tag = tag
	} else if isNew {
		return "every animal needs its tag number"
	}
	if domain.TagKey(a.Tag) == "" {
		return "a tag has to have a letter or a number in it"
	}

	if req.Name != "" || !isNew {
		a.Name = strings.TrimSpace(req.Name)
	}
	if species := strings.ToLower(strings.TrimSpace(req.Species)); species != "" {
		if species != domain.SpeciesBuffalo && species != domain.SpeciesCow {
			return "an animal is a buffalo or a cow"
		}
		a.Species = species
	}
	if sex := strings.ToLower(strings.TrimSpace(req.Sex)); sex != "" {
		if sex != "female" && sex != "male" {
			return "sex is female or male"
		}
		a.Sex = sex
	}
	if stage := strings.ToLower(strings.TrimSpace(req.Stage)); stage != "" {
		if !domain.ValidStage(stage) {
			return "that is not a stage this app knows"
		}
		a.Stage = stage
	}
	// Sex and stage have to agree: a bull is never milking and a cow is
	// never a bull. Checked after both are applied, because either one
	// can be the field that just changed — switching a "milking" animal
	// to male must fail as loudly as naming a male one "milking".
	//
	// The exception is a new animal whose stage nobody gave: the default
	// was chosen before we knew the sex, so it is corrected rather than
	// refused. Refusing would mean an admin adding a bull calf gets an
	// error about a field they never filled in.
	if !domain.StageAllowedForSex(a.Stage, a.Sex) {
		if isNew && strings.TrimSpace(req.Stage) == "" {
			a.Stage = domain.DefaultStageFor(a.Sex)
		} else {
			return fmt.Sprintf("a %s animal cannot be %q — that stage is %s only",
				a.Sex, a.Stage, otherSex(a.Sex))
		}
	}
	for _, date := range []struct {
		value string
		into  *string
		what  string
	}{
		{req.BornOn, &a.BornOn, "born on"},
		{req.ArrivedOn, &a.ArrivedOn, "brought to the farm"},
	} {
		trimmed := strings.TrimSpace(date.value)
		if trimmed == "" {
			*date.into = ""
			continue
		}
		if _, err := time.Parse(domain.DateLayout, trimmed); err != nil {
			return fmt.Sprintf("%q is not a date — use YYYY-MM-DD for %s", trimmed, date.what)
		}
		*date.into = trimmed
	}
	a.Breed = strings.TrimSpace(req.Breed)
	a.Source = strings.TrimSpace(req.Source)
	a.Notes = strings.TrimSpace(req.Notes)
	if req.Active != nil {
		a.Active = *req.Active
	}
	return ""
}

func otherSex(sex string) string {
	if strings.EqualFold(strings.TrimSpace(sex), "male") {
		return "female"
	}
	return "male"
}

func (s *Server) handleCreateAnimal(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req animalRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	animal := domain.Animal{
		ID:         domain.NewID(),
		BusinessID: sess.Business.ID,
		Species:    domain.SpeciesBuffalo,
		Sex:        "female",
		Stage:      domain.StageMilking,
		Active:     true,
	}
	if problem := req.applyTo(&animal, true); problem != "" {
		writeError(w, http.StatusBadRequest, problem, "invalid_animal")
		return
	}

	saved, err := s.store.CreateAnimal(r.Context(), animal)
	if err != nil {
		if err == storage.ErrConflict {
			writeError(w, http.StatusConflict,
				fmt.Sprintf("tag %s is already on this farm", animal.Tag), "tag_taken")
			return
		}
		writeStoreError(w, err, "animal")
		return
	}
	writeJSON(w, http.StatusCreated, saved)
}

func (s *Server) handleUpdateAnimal(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	animal, err := s.store.GetAnimal(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "animal")
		return
	}

	var req animalRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if problem := req.applyTo(&animal, false); problem != "" {
		writeError(w, http.StatusBadRequest, problem, "invalid_animal")
		return
	}

	saved, err := s.store.UpdateAnimal(r.Context(), animal)
	if err != nil {
		if err == storage.ErrConflict {
			writeError(w, http.StatusConflict,
				fmt.Sprintf("tag %s is already on this farm", animal.Tag), "tag_taken")
			return
		}
		writeStoreError(w, err, "animal")
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

// handleDeleteAnimal removes an animal outright, behind the same window
// as every other delete.
//
// Selling an animal or losing one is a change of stage, not a deletion —
// its milk records still happened and its calves are still in the herd.
// This is for a tag typed wrong.
func (s *Server) handleDeleteAnimal(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	if !s.requireDeleteMode(w, r, sess) {
		return
	}

	animal, err := s.store.GetAnimal(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "animal")
		return
	}
	if err := s.store.DeleteAnimal(r.Context(), sess.Business.ID, animal.ID); err != nil {
		writeStoreError(w, err, "animal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": animal.Tag})
}

// ---------- crossings ----------

func (s *Server) handleListBreedings(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	animal, err := s.store.GetAnimal(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "animal")
		return
	}
	list, err := s.store.ListBreedings(r.Context(), sess.Business.ID, animal.ID)
	if err != nil {
		writeStoreError(w, err, "crossings")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"breedings": withDueDates(list, animal.Species)})
}

// withDueDates hands back each crossing with the date a calf would be
// expected from it, so no screen has to know a gestation length.
func withDueDates(list []domain.Breeding, species string) []map[string]any {
	out := make([]map[string]any, 0, len(list))
	for _, b := range list {
		out = append(out, map[string]any{
			"id": b.ID, "animal_id": b.AnimalID, "crossed_on": b.CrossedOn,
			"method": b.Method, "sire": b.Sire, "result": b.Result,
			"checked_on": b.CheckedOn, "calved_on": b.CalvedOn,
			"calf_id": b.CalfID, "notes": b.Notes,
			"due_on": b.DueOn(species),
		})
	}
	return out
}

type breedingRequest struct {
	CrossedOn string `json:"crossed_on"`
	Method    string `json:"method"`
	Sire      string `json:"sire"`
	Result    string `json:"result"`
	CheckedOn string `json:"checked_on"`
	CalvedOn  string `json:"calved_on"`
	CalfID    string `json:"calf_id"`
	Notes     string `json:"notes"`
}

func (req breedingRequest) applyTo(b *domain.Breeding, isNew bool) string {
	if crossed := strings.TrimSpace(req.CrossedOn); crossed != "" {
		if _, err := time.Parse(domain.DateLayout, crossed); err != nil {
			return "the crossing date has to be YYYY-MM-DD"
		}
		b.CrossedOn = crossed
	} else if isNew {
		return "a crossing needs the day it happened"
	}

	if method := strings.ToLower(strings.TrimSpace(req.Method)); method != "" {
		if method != "ai" && method != "natural" {
			return "a crossing is by AI or natural service"
		}
		b.Method = method
	}
	if result := strings.ToLower(strings.TrimSpace(req.Result)); result != "" {
		if !domain.ValidBreedingResult(result) {
			return "that is not a result this app knows"
		}
		b.Result = result
	}
	for _, date := range []struct {
		value string
		into  *string
	}{{req.CheckedOn, &b.CheckedOn}, {req.CalvedOn, &b.CalvedOn}} {
		trimmed := strings.TrimSpace(date.value)
		if trimmed == "" {
			*date.into = ""
			continue
		}
		if _, err := time.Parse(domain.DateLayout, trimmed); err != nil {
			return "those dates have to be YYYY-MM-DD"
		}
		*date.into = trimmed
	}
	// A calving date says what happened, so it carries the result with
	// it — leaving a calved crossing marked "pending" would keep it in
	// the due list forever.
	if b.CalvedOn != "" && b.Result != domain.BreedingCalved {
		b.Result = domain.BreedingCalved
	}
	b.Sire = strings.TrimSpace(req.Sire)
	b.CalfID = strings.TrimSpace(req.CalfID)
	b.Notes = strings.TrimSpace(req.Notes)
	return ""
}

func (s *Server) handleCreateBreeding(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	animal, err := s.store.GetAnimal(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "animal")
		return
	}

	// A crossing is recorded against the dam. The male's part is his tag
	// in Sire, which is a text field precisely because he is often not
	// an animal on this farm — he may be a straw of semen with a batch
	// number on it.
	if !animal.Lactates() {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("%s is male — record the crossing against the female, naming him as the sire", animal.Tag),
			"not_breedable")
		return
	}

	var req breedingRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	breeding := domain.Breeding{
		ID:         domain.NewID(),
		BusinessID: sess.Business.ID,
		AnimalID:   animal.ID,
		Method:     "ai",
		Result:     domain.BreedingPending,
	}
	if problem := req.applyTo(&breeding, true); problem != "" {
		writeError(w, http.StatusBadRequest, problem, "invalid_breeding")
		return
	}

	saved, err := s.store.CreateBreeding(r.Context(), breeding)
	if err != nil {
		writeStoreError(w, err, "crossing")
		return
	}
	writeJSON(w, http.StatusCreated, withDueDates([]domain.Breeding{saved}, animal.Species)[0])
}

func (s *Server) handleUpdateBreeding(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	all, err := s.store.ListAllBreedings(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "crossings")
		return
	}
	var breeding domain.Breeding
	found := false
	for _, b := range all {
		if b.ID == r.PathValue("id") {
			breeding, found = b, true
			break
		}
	}
	if !found {
		writeError(w, http.StatusNotFound, "that crossing was not found", "not_found")
		return
	}

	var req breedingRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if problem := req.applyTo(&breeding, false); problem != "" {
		writeError(w, http.StatusBadRequest, problem, "invalid_breeding")
		return
	}

	saved, err := s.store.UpdateBreeding(r.Context(), breeding)
	if err != nil {
		writeStoreError(w, err, "crossing")
		return
	}
	animal, err := s.store.GetAnimal(r.Context(), sess.Business.ID, saved.AnimalID)
	if err != nil {
		writeStoreError(w, err, "animal")
		return
	}

	// Calving is the one moment this app knows for certain that an
	// animal is about to start milking. Leaving her on "dry" means she
	// is missing from the milking sheet tomorrow morning, and milk that
	// nobody is prompted to record is milk that goes unrecorded.
	//
	// A heifer moves too: calving is exactly what turns one into a cow.
	// Nothing else is touched — an animal already milking stays milking,
	// and a sold one is not brought back by a late record.
	freshened := false
	if saved.Result == domain.BreedingCalved &&
		(animal.Stage == domain.StageDry || animal.Stage == domain.StageHeifer) {
		animal.Stage = domain.StageMilking
		if updated, err := s.store.UpdateAnimal(r.Context(), animal); err == nil {
			animal, freshened = updated, true
		} else {
			log.Printf("calving: move %s back to milking: %v", animal.Tag, err)
		}
	}

	body := withDueDates([]domain.Breeding{saved}, animal.Species)[0]
	body["freshened"] = freshened
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) handleDeleteBreeding(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	if !s.requireDeleteMode(w, r, sess) {
		return
	}
	if err := s.store.DeleteBreeding(r.Context(), sess.Business.ID, r.PathValue("id")); err != nil {
		writeStoreError(w, err, "crossing")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// ---------- milk ----------

// handleHerdDay is the whole page for one day: every animal, what each
// gave that morning and evening, and what is due to calve.
//
// One request because it is one screen. The alternative was the milking
// page making a call per animal, which on a forty-head farm is forty
// requests to draw a table.
func (s *Server) handleHerdDay(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	date, ok := resolveDate(sess.Business, r)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	animals, err := s.store.ListAnimals(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "animals")
		return
	}
	yields, err := s.store.ListMilkYields(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "milk")
		return
	}
	breedings, err := s.store.ListAllBreedings(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "crossings")
		return
	}

	// The one crossing per animal that is still expecting something.
	// Newest first from the store, so the first hit is the current one —
	// an animal served twice after a failed check has two rows and only
	// the later one is a due date.
	species := map[string]string{}
	for _, a := range animals {
		species[a.ID] = a.Species
	}
	due := map[string]string{}
	for _, b := range breedings {
		if _, already := due[b.AnimalID]; already {
			continue
		}
		if when := b.DueOn(species[b.AnimalID]); when != "" {
			due[b.AnimalID] = when
		}
	}

	// What each animal normally gives, so the sheet can show today's
	// figure against her own usual one. Same window the drop detector
	// judges against, so the faint number beside a cell is the number
	// the alert would be measured from — two different answers to "what
	// is normal for her" on one screen would be worse than neither.
	averages, err := s.herdAverages(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "milk")
		return
	}

	events, err := s.store.ListAllHealthEvents(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "health")
		return
	}
	// Whose milk must not go in the churn today, and why. Keyed by
	// animal so the sheet can say so on the row somebody is about to
	// type into.
	withheld := map[string]any{}
	for _, e := range events {
		if e.WithholdingOn(date) {
			withheld[e.AnimalID] = map[string]any{
				"until": e.MilkWithheldUntil, "reason": e.Name, "kind": e.Kind,
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"date":     date,
		"animals":  animals,
		"yields":   yields,
		"due":      due,
		"averages": averages,
		"withheld": withheld,
	})
}

// herdAverages is every animal's own recent average, per session and in
// total, over the same window the drop detector uses.
//
// Days nobody recorded are not zeros and are left out of the division —
// an animal milked on four of the last fourteen days averages what she
// gave on those four, not a quarter of it.
func (s *Server) herdAverages(ctx context.Context, businessID, date string) (map[string]any, error) {
	on, err := time.Parse(domain.DateLayout, date)
	if err != nil {
		return map[string]any{}, nil
	}
	from := on.AddDate(0, 0, -domain.YieldAlertWindowDays).Format(domain.DateLayout)
	to := on.AddDate(0, 0, -1).Format(domain.DateLayout)

	history, err := s.store.ListYieldsBetween(ctx, businessID, from, to)
	if err != nil {
		return nil, err
	}

	type running struct {
		morning, evening float64
		days             int
	}
	sums := map[string]*running{}
	for _, y := range history {
		acc := sums[y.AnimalID]
		if acc == nil {
			acc = &running{}
			sums[y.AnimalID] = acc
		}
		acc.morning += y.Morning
		acc.evening += y.Evening
		acc.days++
	}

	out := map[string]any{}
	for animalID, acc := range sums {
		if acc.days == 0 {
			continue
		}
		days := float64(acc.days)
		out[animalID] = map[string]any{
			"morning": acc.morning / days,
			"evening": acc.evening / days,
			"total":   (acc.morning + acc.evening) / days,
			"days":    acc.days,
		}
	}
	return out, nil
}

func (s *Server) handleSetMilkYield(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	animal, err := s.store.GetAnimal(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "animal")
		return
	}

	// Milk from a bull is not a typo to be tolerated, it is impossible —
	// and a lactation record on a male would join every total on the
	// milking sheet for that day.
	if !animal.Lactates() {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("%s is male — milk cannot be recorded against him", animal.Tag), "not_milkable")
		return
	}

	var req struct {
		Date    string   `json:"date"`
		Morning *float64 `json:"morning"`
		Evening *float64 `json:"evening"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	date := strings.TrimSpace(req.Date)
	if date == "" {
		date = sess.Business.Today()
	} else if _, err := time.Parse(domain.DateLayout, date); err != nil {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	// Only what was sent changes. The two sessions are entered hours
	// apart by whoever milked, and an evening figure must not wipe the
	// morning's just by being the only field in the request.
	existing, err := s.store.ListMilkYields(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "milk")
		return
	}
	yield := existing[animal.ID]
	yield.BusinessID = sess.Business.ID
	yield.AnimalID = animal.ID
	yield.Date = date
	if req.Morning != nil {
		if *req.Morning < 0 {
			writeError(w, http.StatusBadRequest, "milk cannot be negative", "invalid_yield")
			return
		}
		yield.Morning = *req.Morning
	}
	if req.Evening != nil {
		if *req.Evening < 0 {
			writeError(w, http.StatusBadRequest, "milk cannot be negative", "invalid_yield")
			return
		}
		yield.Evening = *req.Evening
	}

	if err := s.store.SetMilkYield(r.Context(), yield); err != nil {
		writeStoreError(w, err, "milk")
		return
	}
	s.maybeRaiseYieldAlert(r.Context(), sess.Business.ID, animal.ID, date, yield.Total(),
		sess.Business.Config.YieldDropThreshold())
	writeJSON(w, http.StatusOK, yield)
}

// maybeRaiseYieldAlert is called after every milk entry. It never fails
// the write it rides on: a farmer's milk record must land even if the
// herd's history can't be read back for some reason.
//
// Detection deliberately runs off the animal's own baseline, not a herd
// average or a fixed number a species is "supposed to" give — a genuinely
// high-yielding buffalo dropping to what would be a normal buffalo's
// output is still the same warning sign as any other animal falling off
// its own pace.
func (s *Server) maybeRaiseYieldAlert(ctx context.Context, businessID, animalID, date string, total float64, threshold float64) {
	parsed, err := time.Parse(domain.DateLayout, date)
	if err != nil {
		return
	}

	// A cow under treatment milks badly, and that is not news — somebody
	// wrote the treatment down precisely because they already know.
	// Alerting here would fire hardest exactly when the herd is least
	// healthy, which is the fastest way to teach a farmer to ignore the
	// tab altogether.
	treatments, err := s.store.ListHealthEvents(ctx, businessID, animalID)
	if err != nil {
		log.Printf("yield alert: read health for animal %s: %v", animalID, err)
		return
	}
	for _, e := range treatments {
		if e.WithholdingOn(date) {
			return
		}
	}
	// The window looks back from the day before the one just entered —
	// today's own figure is what is being judged, not folded into what
	// it's judged against.
	from := parsed.AddDate(0, 0, -domain.YieldAlertWindowDays).Format(domain.DateLayout)
	to := parsed.AddDate(0, 0, -1).Format(domain.DateLayout)

	history, err := s.store.ListAnimalYields(ctx, businessID, animalID, from, to)
	if err != nil {
		log.Printf("yield alert: read history for animal %s: %v", animalID, err)
		return
	}
	baseline, ok := domain.YieldBaseline(history)
	if !ok || !domain.IsYieldDrop(baseline, total, threshold) {
		return
	}

	// One open alert per animal at a time — a sustained drop doesn't
	// raise a new one every milking until somebody deals with the first.
	if _, err := s.store.OpenHerdAlert(ctx, businessID, animalID, domain.AlertYieldDrop); err == nil {
		return
	} else if err != storage.ErrNotFound {
		log.Printf("yield alert: check existing alert for animal %s: %v", animalID, err)
		return
	}

	alert := domain.HerdAlert{
		ID: domain.NewID(), BusinessID: businessID, AnimalID: animalID,
		Kind: domain.AlertYieldDrop, RaisedOn: date,
		Baseline: baseline, Actual: total, Status: domain.AlertOpen,
	}
	if _, err := s.store.CreateHerdAlert(ctx, alert); err != nil {
		log.Printf("yield alert: create alert for animal %s: %v", animalID, err)
	}
}

// ---------- herd alerts ----------

func (s *Server) handleListHerdAlerts(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	alerts, err := s.store.ListOpenHerdAlerts(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "alerts")
		return
	}

	// Each alert reads with the animal's tag, not just its id — the tag
	// is what a farmer recognises, same reasoning as everywhere else in
	// the herd screens.
	animals, err := s.store.ListAnimals(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "animals")
		return
	}
	tags := map[string]string{}
	for _, a := range animals {
		tags[a.ID] = a.Tag
	}

	out := make([]map[string]any, 0, len(alerts))
	for _, a := range alerts {
		out = append(out, map[string]any{
			"id": a.ID, "animal_id": a.AnimalID, "animal_tag": tags[a.AnimalID],
			"kind": a.Kind, "raised_on": a.RaisedOn,
			"baseline": a.Baseline, "actual": a.Actual, "drop_pct": a.DropPct(),
			"status": a.Status, "note": a.Note, "resolved_on": a.ResolvedOn,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"alerts": out})
}

// handleCreateHerdAlert is a farmer raising one themselves.
//
// The detector only knows what the milk says. Somebody standing in the
// shed can see a limp, a swollen udder or an animal off her feed a day
// before the can does, and the honest answer to that is somewhere to
// write it down — not a cleverer detector.
func (s *Server) handleCreateHerdAlert(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		AnimalID string `json:"animal_id"`
		Note     string `json:"note"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	animal, err := s.store.GetAnimal(r.Context(), sess.Business.ID, strings.TrimSpace(req.AnimalID))
	if err != nil {
		writeStoreError(w, err, "animal")
		return
	}
	note := strings.TrimSpace(req.Note)
	if note == "" {
		writeError(w, http.StatusBadRequest, "say what you noticed", "empty_note")
		return
	}

	alert := domain.HerdAlert{
		ID: domain.NewID(), BusinessID: sess.Business.ID, AnimalID: animal.ID,
		Kind: domain.AlertManual, RaisedOn: sess.Business.Today(),
		Status: domain.AlertOpen, Note: note,
	}
	saved, err := s.store.CreateHerdAlert(r.Context(), alert)
	if err != nil {
		writeStoreError(w, err, "alert")
		return
	}
	writeJSON(w, http.StatusCreated, saved)
}

func (s *Server) handleUpdateHerdAlert(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	alerts, err := s.store.ListOpenHerdAlerts(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "alerts")
		return
	}
	var alert domain.HerdAlert
	found := false
	for _, a := range alerts {
		if a.ID == r.PathValue("id") {
			alert, found = a, true
			break
		}
	}
	if !found {
		writeError(w, http.StatusNotFound, "that alert was not found", "not_found")
		return
	}

	var req struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	status := strings.ToLower(strings.TrimSpace(req.Status))
	if status == "" || !domain.ValidAlertStatus(status) {
		writeError(w, http.StatusBadRequest, "that is not a status this app knows", "invalid_status")
		return
	}
	alert.Status = status
	alert.Note = strings.TrimSpace(req.Note)
	if status == domain.AlertResolved {
		alert.ResolvedOn = sess.Business.Today()
	} else {
		alert.ResolvedOn = ""
	}

	saved, err := s.store.UpdateHerdAlert(r.Context(), alert)
	if err != nil {
		writeStoreError(w, err, "alert")
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

// handleAnimalYields is one animal's own record — what it has been
// giving, so a farmer can see a drop rather than remember one.
func (s *Server) handleAnimalYields(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	animal, err := s.store.GetAnimal(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "animal")
		return
	}

	today, err := time.Parse(domain.DateLayout, sess.Business.Today())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "bad_today")
		return
	}
	from := today.AddDate(0, 0, -maxHistoryDays).Format(domain.DateLayout)
	to := today.Format(domain.DateLayout)

	yields, err := s.store.ListAnimalYields(r.Context(), sess.Business.ID, animal.ID, from, to)
	if err != nil {
		writeStoreError(w, err, "milk")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"yields": yields})
}

// ---------- the health book ----------

// How far ahead a jab counts as "coming up". A month is roughly how far
// in advance somebody can actually arrange a vet, and short enough that
// the list is still about this month rather than this year.
const healthDueWindowDays = 30

type healthEventRequest struct {
	Kind              string `json:"kind"`
	Name              string `json:"name"`
	Date              string `json:"date"`
	Batch             string `json:"batch"`
	Dose              string `json:"dose"`
	Vet               string `json:"vet"`
	CostRupees        *int   `json:"cost_rupees"`
	NextDueOn         string `json:"next_due_on"`
	MilkWithheldUntil string `json:"milk_withheld_until"`
	Notes             string `json:"notes"`
}

func (req healthEventRequest) applyTo(e *domain.HealthEvent, isNew bool) string {
	if kind := strings.ToLower(strings.TrimSpace(req.Kind)); kind != "" {
		if !domain.ValidHealthKind(kind) {
			return "that is not a kind of record this app keeps"
		}
		e.Kind = kind
	}
	if name := strings.TrimSpace(req.Name); name != "" {
		e.Name = name
	} else if isNew {
		return "say what was given or found"
	}
	if date := strings.TrimSpace(req.Date); date != "" {
		if _, err := time.Parse(domain.DateLayout, date); err != nil {
			return "the date has to be YYYY-MM-DD"
		}
		e.Date = date
	}
	// Checked on the value rather than on the request: a new event
	// arrives already dated today, so "gave her the FMD jab" needs no
	// date typed at all. Only a genuinely empty one is refused.
	if e.Date == "" {
		return "a health record needs the day it happened"
	}

	for _, field := range []struct {
		value string
		into  *string
		what  string
	}{
		{req.NextDueOn, &e.NextDueOn, "the next one is due"},
		{req.MilkWithheldUntil, &e.MilkWithheldUntil, "milk is withheld until"},
	} {
		trimmed := strings.TrimSpace(field.value)
		if trimmed == "" {
			*field.into = ""
			continue
		}
		if _, err := time.Parse(domain.DateLayout, trimmed); err != nil {
			return fmt.Sprintf("%q is not a date — use YYYY-MM-DD for when %s", trimmed, field.what)
		}
		*field.into = trimmed
	}

	// A jab whose next one nobody typed gets the usual interval for its
	// name: FMD every six months, HS and BQ annually. A vet who says
	// otherwise wins, which is why this only fills a blank.
	if e.NextDueOn == "" && (e.Kind == domain.HealthVaccination || e.Kind == domain.HealthDeworming) {
		e.NextDueOn = domain.SuggestedNextDue(e.Name, e.Date)
	}

	if req.CostRupees != nil {
		if *req.CostRupees < 0 {
			return "a cost cannot be negative"
		}
		e.CostRupees = *req.CostRupees
	}
	e.Batch = strings.TrimSpace(req.Batch)
	e.Dose = strings.TrimSpace(req.Dose)
	e.Vet = strings.TrimSpace(req.Vet)
	e.Notes = strings.TrimSpace(req.Notes)
	return ""
}

func (s *Server) handleListHealthEvents(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	animal, err := s.store.GetAnimal(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "animal")
		return
	}
	list, err := s.store.ListHealthEvents(r.Context(), sess.Business.ID, animal.ID)
	if err != nil {
		writeStoreError(w, err, "health")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": list})
}

func (s *Server) handleCreateHealthEvent(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	animal, err := s.store.GetAnimal(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "animal")
		return
	}

	var req healthEventRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	event := domain.HealthEvent{
		ID:         domain.NewID(),
		BusinessID: sess.Business.ID,
		AnimalID:   animal.ID,
		Kind:       domain.HealthVaccination,
		Date:       sess.Business.Today(),
	}
	if problem := req.applyTo(&event, true); problem != "" {
		writeError(w, http.StatusBadRequest, problem, "invalid_health_event")
		return
	}

	saved, err := s.store.CreateHealthEvent(r.Context(), event)
	if err != nil {
		writeStoreError(w, err, "health")
		return
	}
	writeJSON(w, http.StatusCreated, saved)
}

func (s *Server) handleUpdateHealthEvent(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	all, err := s.store.ListAllHealthEvents(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "health")
		return
	}
	var event domain.HealthEvent
	found := false
	for _, e := range all {
		if e.ID == r.PathValue("id") {
			event, found = e, true
			break
		}
	}
	if !found {
		writeError(w, http.StatusNotFound, "that health record was not found", "not_found")
		return
	}

	var req healthEventRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if problem := req.applyTo(&event, false); problem != "" {
		writeError(w, http.StatusBadRequest, problem, "invalid_health_event")
		return
	}

	saved, err := s.store.UpdateHealthEvent(r.Context(), event)
	if err != nil {
		writeStoreError(w, err, "health")
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

func (s *Server) handleDeleteHealthEvent(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	if !s.requireDeleteMode(w, r, sess) {
		return
	}
	if err := s.store.DeleteHealthEvent(r.Context(), sess.Business.ID, r.PathValue("id")); err != nil {
		writeStoreError(w, err, "health")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// handleHealthDue is what the herd owes: jabs coming up, jabs overdue,
// and whose milk is currently being held back.
//
// Derived rather than stored. A vaccination falling due is not an event
// somebody has to dismiss — it is a fact about the last one, and it
// stops being true the moment the next jab is recorded. Persisting it
// would mean two places that disagree about whether FMD is due.
func (s *Server) handleHealthDue(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	events, err := s.store.ListAllHealthEvents(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "health")
		return
	}
	animals, err := s.store.ListAnimals(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "animals")
		return
	}
	// Only animals still on the farm. A cow sold in June does not need
	// her FMD booster, and a due list that slowly fills with animals
	// who left is how somebody learns to stop reading it.
	tags := map[string]string{}
	for _, a := range animals {
		if a.OnTheFarm() {
			tags[a.ID] = a.Tag
		}
	}

	today := sess.Business.Today()
	horizon := today
	if on, err := time.Parse(domain.DateLayout, today); err == nil {
		horizon = on.AddDate(0, 0, healthDueWindowDays).Format(domain.DateLayout)
	}

	// Only the newest record of each name per animal can be due: giving
	// FMD again supersedes last year's, and both carry a next-due date.
	// ListAllHealthEvents is newest first, so the first one wins.
	seen := map[string]bool{}
	due := []map[string]any{}
	withheld := []map[string]any{}
	for _, e := range events {
		if _, onFarm := tags[e.AnimalID]; !onFarm {
			continue
		}
		if e.WithholdingOn(today) {
			withheld = append(withheld, map[string]any{
				"animal_id": e.AnimalID, "animal_tag": tags[e.AnimalID],
				"until": e.MilkWithheldUntil, "reason": e.Name,
			})
		}
		key := e.AnimalID + "\x00" + strings.ToLower(e.Name)
		if seen[key] {
			continue
		}
		seen[key] = true
		if e.NextDueOn == "" || e.NextDueOn > horizon {
			continue
		}
		due = append(due, map[string]any{
			"animal_id": e.AnimalID, "animal_tag": tags[e.AnimalID],
			"kind": e.Kind, "name": e.Name, "due_on": e.NextDueOn,
			"overdue": e.NextDueOn < today,
		})
	}

	sort.Slice(due, func(i, j int) bool {
		return due[i]["due_on"].(string) < due[j]["due_on"].(string)
	})
	writeJSON(w, http.StatusOK, map[string]any{"due": due, "withheld": withheld})
}

// handleVaccinateHerd records one jab against many animals at once.
//
// A vaccination round is a herd event, not an animal event: the vet
// comes on a Tuesday and does everything on the farm. Recording that
// one animal at a time is twenty trips through a form on a phone, in a
// shed, and it is the reason herd books stop being kept.
//
// Animals already carrying this jab on this date are skipped rather than
// duplicated, so pressing the button twice — or catching the three that
// were out at pasture in a second pass — does the right thing.
func (s *Server) handleVaccinateHerd(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Kind  string `json:"kind"`
		Name  string `json:"name"`
		Date  string `json:"date"`
		Vet   string `json:"vet"`
		Batch string `json:"batch"`
		Notes string `json:"notes"`
		// AnimalIDs narrows it. Empty means every animal still on the
		// farm, which is what a vaccination round actually is.
		AnimalIDs []string `json:"animal_ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "say what is being given", "invalid_health_event")
		return
	}
	kind := strings.ToLower(strings.TrimSpace(req.Kind))
	if kind == "" {
		kind = domain.HealthVaccination
	}
	if !domain.ValidHealthKind(kind) {
		writeError(w, http.StatusBadRequest, "that is not a kind of record this app keeps", "invalid_health_event")
		return
	}
	date := strings.TrimSpace(req.Date)
	if date == "" {
		date = sess.Business.Today()
	} else if _, err := time.Parse(domain.DateLayout, date); err != nil {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	animals, err := s.store.ListAnimals(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "animals")
		return
	}
	wanted := map[string]bool{}
	for _, id := range req.AnimalIDs {
		wanted[strings.TrimSpace(id)] = true
	}

	existing, err := s.store.ListAllHealthEvents(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "health")
		return
	}
	already := map[string]bool{}
	for _, e := range existing {
		if e.Date == date && strings.EqualFold(e.Name, name) {
			already[e.AnimalID] = true
		}
	}

	nextDue := domain.SuggestedNextDue(name, date)
	given := []string{}
	skipped := 0
	for _, a := range animals {
		if !a.OnTheFarm() {
			continue
		}
		if len(wanted) > 0 && !wanted[a.ID] {
			continue
		}
		if already[a.ID] {
			skipped++
			continue
		}
		event := domain.HealthEvent{
			ID: domain.NewID(), BusinessID: sess.Business.ID, AnimalID: a.ID,
			Kind: kind, Name: name, Date: date, Vet: strings.TrimSpace(req.Vet),
			Batch: strings.TrimSpace(req.Batch), Notes: strings.TrimSpace(req.Notes),
			NextDueOn: nextDue,
		}
		if _, err := s.store.CreateHealthEvent(r.Context(), event); err != nil {
			writeStoreError(w, err, "health")
			return
		}
		given = append(given, a.Tag)
	}

	log.Printf("herd: %s given to %d animals on %s (%d already had it)",
		name, len(given), date, skipped)
	writeJSON(w, http.StatusCreated, map[string]any{
		"given": given, "count": len(given), "skipped": skipped,
		"name": name, "date": date, "next_due_on": nextDue,
	})
}

// handleHerdSummary is what the farm produced over a span of days.
//
// Every other question this app answers about milk is about one day or
// one animal. "How much did we make this month" is the one a dairy owner
// actually asks, and until now the data was all here with no way to ask
// it.
//
// Milk withheld under a drug withdrawal is counted separately rather
// than silently included: it was produced but it cannot be sold, and a
// figure that blurs the two is the wrong number for both questions.
func (s *Server) handleHerdSummary(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	to := strings.TrimSpace(r.URL.Query().Get("to"))
	if to == "" {
		to = sess.Business.Today()
	}
	end, err := time.Parse(domain.DateLayout, to)
	if err != nil {
		writeError(w, http.StatusBadRequest, "to must be YYYY-MM-DD", "invalid_date")
		return
	}
	from := strings.TrimSpace(r.URL.Query().Get("from"))
	if from == "" {
		from = end.AddDate(0, 0, -29).Format(domain.DateLayout)
	}
	if _, err := time.Parse(domain.DateLayout, from); err != nil {
		writeError(w, http.StatusBadRequest, "from must be YYYY-MM-DD", "invalid_date")
		return
	}
	if from > to {
		writeError(w, http.StatusBadRequest, "the range starts after it ends", "invalid_range")
		return
	}

	yields, err := s.store.ListYieldsBetween(r.Context(), sess.Business.ID, from, to)
	if err != nil {
		writeStoreError(w, err, "milk")
		return
	}
	events, err := s.store.ListAllHealthEvents(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "health")
		return
	}
	animals, err := s.store.ListAnimals(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "animals")
		return
	}
	tags := map[string]string{}
	for _, a := range animals {
		tags[a.ID] = a.Tag
	}

	type dayTotal struct {
		morning, evening, discarded float64
		animals                     map[string]bool
	}
	byDate := map[string]*dayTotal{}
	perAnimal := map[string]float64{}
	var totalMorning, totalEvening, totalDiscarded float64

	for _, y := range yields {
		acc := byDate[y.Date]
		if acc == nil {
			acc = &dayTotal{animals: map[string]bool{}}
			byDate[y.Date] = acc
		}
		acc.animals[y.AnimalID] = true

		// Was this animal under a withdrawal on that day?
		withheld := false
		for _, e := range events {
			if e.AnimalID == y.AnimalID && e.WithholdingOn(y.Date) && y.Date >= e.Date {
				withheld = true
				break
			}
		}
		if withheld {
			acc.discarded += y.Total()
			totalDiscarded += y.Total()
			continue
		}
		acc.morning += y.Morning
		acc.evening += y.Evening
		totalMorning += y.Morning
		totalEvening += y.Evening
		perAnimal[y.AnimalID] += y.Total()
	}

	days := make([]map[string]any, 0, len(byDate))
	for date, acc := range byDate {
		days = append(days, map[string]any{
			"date": date, "morning": acc.morning, "evening": acc.evening,
			"total": acc.morning + acc.evening, "discarded": acc.discarded,
			"animals": len(acc.animals),
		})
	}
	sort.Slice(days, func(i, j int) bool {
		return days[i]["date"].(string) > days[j]["date"].(string)
	})

	// Who carried the herd. Only worth a handful — a forty-row league
	// table is not a thing anybody reads.
	type share struct {
		id, tag string
		litres  float64
	}
	shares := make([]share, 0, len(perAnimal))
	for id, litres := range perAnimal {
		shares = append(shares, share{id: id, tag: tags[id], litres: litres})
	}
	sort.Slice(shares, func(i, j int) bool { return shares[i].litres > shares[j].litres })
	top := []map[string]any{}
	for i, sh := range shares {
		if i >= 5 {
			break
		}
		top = append(top, map[string]any{"animal_id": sh.id, "animal_tag": sh.tag, "total": sh.litres})
	}

	recorded := len(byDate)
	perDay := 0.0
	if recorded > 0 {
		perDay = (totalMorning + totalEvening) / float64(recorded)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from": from, "to": to,
		"days": days,
		"totals": map[string]any{
			"morning": totalMorning, "evening": totalEvening,
			"total": totalMorning + totalEvening, "discarded": totalDiscarded,
			"days_recorded": recorded, "per_day": perDay,
		},
		"top": top,
	})
}
