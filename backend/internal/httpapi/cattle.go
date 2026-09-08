package httpapi

import (
	"fmt"
	"net/http"
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
	writeJSON(w, http.StatusOK, withDueDates([]domain.Breeding{saved}, animal.Species)[0])
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

	writeJSON(w, http.StatusOK, map[string]any{
		"date":    date,
		"animals": animals,
		"yields":  yields,
		"due":     due,
	})
}

func (s *Server) handleSetMilkYield(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	animal, err := s.store.GetAnimal(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "animal")
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
	writeJSON(w, http.StatusOK, yield)
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
