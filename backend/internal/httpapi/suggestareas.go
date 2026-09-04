package httpapi

import (
	"net/http"
	"sort"
	"strings"

	"delivery-manager/internal/route"
)

// Tuning for "where does this business deliver". Both numbers are about
// human geography rather than algorithms.
const (
	// Two customers belong to the same place if you can hop between them
	// in steps shorter than this. Comfortably wider than the gap between
	// neighbouring houses on any street, and far narrower than the gap
	// between a town and the next village, which is the distinction that
	// has to survive.
	suggestLinkMeters = 2500

	// Below this, a "cluster" is a couple of stray customers rather than a
	// place worth drawing a zone around — offering it would just be noise
	// on the one screen a new business most needs to be clear.
	suggestMinCustomers = 3

	// Breathing room added to the circle that just contains the cluster,
	// so the next customer on the same street falls inside rather than
	// immediately becoming a stray.
	suggestPaddingMeters = 700

	// Even one customer needs a circle with some size to it — a business
	// with three houses on one street would otherwise get a 700m suggestion
	// that the fourth house falls straight out of.
	suggestMinRadiusMeters = 1500
)

type areaSuggestion struct {
	Name          string  `json:"name"`
	Lat           float64 `json:"lat"`
	Lng           float64 `json:"lng"`
	RadiusMeters  float64 `json:"radius_meters"`
	CustomerCount int     `json:"customer_count"`
}

// handleSuggestServiceAreas proposes the service areas a business already
// has, without knowing it.
//
// Service areas are the hinge the whole product turns on — no area means
// no round, so every delivery falls through as a stray — and they are
// also the one abstraction a dairy farmer has no word for. The form asks
// for a name, a pin and a radius in kilometres; someone who knows
// perfectly well that they "deliver around Nalgonda town" does not know
// their delivery radius in kilometres and should never have to guess.
//
// They do not have to, because the answer is already in the database.
// Their customers have pins, and where those pins cluster *is* where they
// deliver. This reads that back as something they can accept in one tap.
//
// Only customers outside every existing active area are considered, so
// this stops making suggestions once the business is set up, and a
// business that adds a new town later is offered that town rather than
// the one it already has.
func (s *Server) handleSuggestServiceAreas(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	customers, err := s.store.ListCustomers(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "customers")
		return
	}
	areas, err := s.store.ListServiceAreas(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "service areas")
		return
	}

	uncovered := make([]route.Point, 0, len(customers))
	addressOf := map[string]string{}
	for _, c := range customers {
		if !c.Active || !c.HasPin() {
			continue
		}
		if _, covered := areaForCustomer(c, areas); covered {
			continue
		}
		uncovered = append(uncovered, route.Point{ID: c.ID, Lat: c.Lat, Lng: c.Lng})
		addressOf[c.ID] = c.Address
	}

	suggestions := []areaSuggestion{}
	for _, group := range route.Cluster(uncovered, suggestLinkMeters) {
		if len(group) < suggestMinCustomers {
			continue
		}
		centre, furthest := route.Enclosing(group)
		radius := furthest + suggestPaddingMeters
		if radius < suggestMinRadiusMeters {
			radius = suggestMinRadiusMeters
		}
		suggestions = append(suggestions, areaSuggestion{
			Name:          placeNameFor(group, addressOf),
			Lat:           centre.Lat,
			Lng:           centre.Lng,
			RadiusMeters:  radius,
			CustomerCount: len(group),
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{"suggestions": suggestions})
}

// placeNameFor guesses what a cluster of customers would call itself,
// from the addresses already typed against them.
//
// Indian addresses this product sees run specific-to-general — "39, Clock
// Tower, Nalgonda" — so the end of the address is the locality, and the
// one most of a cluster agrees on is its name. This is a suggestion the
// admin can overwrite in a text field, not a fact, which is what makes a
// guess acceptable here at all.
//
// "The end" used to mean the last comma-separated part, which assumed a
// tidiness real lists do not have. The first business onboarded here had
// thirty-four households and four commas between them: "H No : 5-2-5
// Lateefsab dargha khamman near clocktower nalgonda" is one field of
// free text, so the comma rule handed back the whole address, no two
// customers agreed on anything, and the suggestion arrived with an empty
// name. The last *word* was "nalgonda" for twenty-eight of the
// thirty-four.
//
// So both are tried, commas first because a comma is a deliberate mark
// and a space is not. Matching ignores case: the same town was typed
// "Nalgonda" and "nalgonda" in the same list, and counting those apart is
// how a clear majority turns into two losing halves.
//
// Deliberately not reverse-geocoding. That would mean a network call to a
// third party on a setup screen, an API key to hold, and a dependency the
// architecture note is explicit about avoiding — to produce a string the
// admin is going to read and correct anyway.
func placeNameFor(group []route.Point, addressOf map[string]string) string {
	if name := agreedName(group, addressOf, localityByComma); name != "" {
		return name
	}
	return agreedName(group, addressOf, localityByWord)
}

// The last comma-separated part, ignoring empty ones — a trailing comma
// is common and means nothing.
func localityByComma(address string) string {
	parts := strings.Split(address, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		if part := strings.TrimSpace(parts[i]); part != "" {
			// Only a comma-delimited field short enough to be a place
			// name. A whole free-text address has no commas at all and
			// would otherwise come back here as one enormous "locality"
			// that only its own customer agrees with.
			if len(part) <= maxLocalityLen {
				return part
			}
			return ""
		}
	}
	return ""
}

// The last word, for the free-text address that has no commas to split.
func localityByWord(address string) string {
	fields := strings.Fields(strings.Trim(address, " ,"))
	if len(fields) == 0 {
		return ""
	}
	return strings.Trim(fields[len(fields)-1], ",.")
}

// About as long as a place name gets before it is plainly a sentence.
const maxLocalityLen = 40

func agreedName(group []route.Point, addressOf map[string]string, localityOf func(string) string) string {
	counts := map[string]int{}
	// The spelling to hand back, per lowercased key: the one written
	// most often, so the field offers the business's own word rather
	// than a title-cased invention of ours. It is a suggestion in an
	// editable box, so their spelling beats our idea of a tidy one.
	spellings := map[string][]string{}
	for _, p := range group {
		address := strings.TrimSpace(addressOf[p.ID])
		if address == "" {
			continue
		}
		locality := localityOf(address)
		// A trailing PIN code or house number is not a place name.
		if locality == "" || len(locality) < 3 || isMostlyDigits(locality) {
			continue
		}
		key := strings.ToLower(locality)
		counts[key]++
		spellings[key] = append(spellings[key], locality)
	}
	if len(counts) == 0 {
		return ""
	}

	type tally struct {
		name string
		n    int
	}
	tallies := make([]tally, 0, len(counts))
	for name, n := range counts {
		tallies = append(tallies, tally{name, n})
	}
	sort.SliceStable(tallies, func(i, j int) bool {
		if tallies[i].n != tallies[j].n {
			return tallies[i].n > tallies[j].n
		}
		return tallies[i].name < tallies[j].name
	})

	// A name only half the cluster agrees on is a street, not a locality —
	// better to offer nothing and let the admin type it than to put a
	// confidently wrong word in the field.
	if tallies[0].n*2 < len(group) {
		return ""
	}
	return mostWritten(spellings[tallies[0].name])
}

// The most common of several spellings of the same word, ties going to
// whichever sorts first so the same list always suggests the same name.
func mostWritten(forms []string) string {
	counts := map[string]int{}
	for _, f := range forms {
		counts[f]++
	}
	best := ""
	for form, n := range counts {
		if best == "" || n > counts[best] || (n == counts[best] && form < best) {
			best = form
		}
	}
	return best
}

func isMostlyDigits(s string) bool {
	digits := 0
	for _, r := range s {
		if r >= '0' && r <= '9' {
			digits++
		}
	}
	return digits*2 >= len([]rune(s))
}
