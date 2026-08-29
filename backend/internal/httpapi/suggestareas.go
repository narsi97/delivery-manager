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
		if _, covered := areaContaining(c.Lat, c.Lng, areas); covered {
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
// Tower, Nalgonda" — so the last comma-separated part is the locality,
// and the one most of a cluster agrees on is its name. This is a
// suggestion the admin can overwrite in a text field, not a fact, which
// is what makes a guess acceptable here at all.
//
// Deliberately not reverse-geocoding. That would mean a network call to a
// third party on a setup screen, an API key to hold, and a dependency the
// architecture note is explicit about avoiding — to produce a string the
// admin is going to read and correct anyway.
func placeNameFor(group []route.Point, addressOf map[string]string) string {
	counts := map[string]int{}
	for _, p := range group {
		address := strings.TrimSpace(addressOf[p.ID])
		if address == "" {
			continue
		}
		parts := strings.Split(address, ",")
		locality := strings.TrimSpace(parts[len(parts)-1])
		// A trailing PIN code or house number is not a place name.
		if locality == "" || len(locality) < 3 || isMostlyDigits(locality) {
			continue
		}
		counts[locality]++
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
	return tallies[0].name
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
