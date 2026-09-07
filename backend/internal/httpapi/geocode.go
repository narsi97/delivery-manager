package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Looking up a written address, so a map opens where the address is.
//
// An Indian delivery address is written for a person who already knows
// the area — "Shiva Balaji Hotel, Shivaji Nagar, Beside S.B.I Bank". No
// geocoder will land that on a doorstep, and this does not try to. What
// it does is get the map to the right neighbourhood, so the admin is
// dragging a pin two streets rather than scrolling across a state.
//
// Deliberately a suggestion, never a saved location. Nothing here writes
// a customer's coordinates: the answer moves the view, and a human still
// puts the pin where the door is. The same rule the stock suggestion
// follows, for the same reason — a coordinate nobody looked at is worse
// than no coordinate, because a round will be built on it.
//
// ARCHITECTURE.md rules out an external dependency "on the critical
// morning path". This is not on it: placing a pin is setup, it is asked
// for by a person pressing a button, and when the lookup fails the map
// opens exactly where it used to. A morning's routing never calls it.
const (
	nominatimURL = "https://nominatim.openstreetmap.org/search"
	// Nominatim's usage policy asks for one request a second and an
	// identifying User-Agent. Both are kept here rather than trusted to
	// callers, because the browser cannot be asked to police them.
	nominatimGap     = 1100 * time.Millisecond
	nominatimTimeout = 6 * time.Second
	nominatimAgent   = "delivery-manager/1.0 (+https://3vnsystems.com)"
)

type geocodeHit struct {
	Label string  `json:"label"`
	Lat   float64 `json:"lat"`
	Lng   float64 `json:"lng"`
}

// One at a time, no faster than the policy allows, and remembering what
// it has already been told. A dairy looks the same twelve addresses up
// repeatedly while working through a list of unpinned customers.
var (
	geocodeMu   sync.Mutex
	geocodeLast time.Time
	geocodeSeen = map[string][]geocodeHit{}
)

func (s *Server) handleGeocode(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeError(w, http.StatusBadRequest, "nothing to look up", "empty_query")
		return
	}
	if len(query) > 300 {
		query = query[:300]
	}

	// Biased towards where this business delivers. "Shivaji Nagar" is a
	// name several states have, and the one that matters is the one near
	// the farm.
	var around string
	if sess.Business.HomeLat != 0 || sess.Business.HomeLng != 0 {
		around = fmt.Sprintf("%.4f,%.4f,%.4f,%.4f",
			sess.Business.HomeLng-1.5, sess.Business.HomeLat+1.5,
			sess.Business.HomeLng+1.5, sess.Business.HomeLat-1.5)
	}

	// Tried from the most specific wording down to the least. A written
	// Indian address is a chain of decreasing precision — a shop, a
	// colony, a landmark, a town — and geocoders answer the general end
	// of it. Stopping at the first thing that lands means the map opens
	// on the colony where it can and on the town where it cannot, which
	// is still the difference between a drag of two streets and a scroll
	// across a state.
	for _, candidate := range geocodeCandidates(query) {
		hits, err := geocode(r.Context(), candidate, around)
		if err != nil {
			// A lookup that fails is not an error the admin has to act
			// on — the map still opens, and the pin still goes down by
			// hand.
			log.Printf("geocode %q: %v", candidate, err)
			break
		}
		if len(hits) > 0 {
			writeJSON(w, http.StatusOK, map[string]any{"places": hits})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"places": []geocodeHit{}})
}

// Words that begin a landmark rather than a place. "Beside S.B.I Bank"
// is how somebody tells a driver where to stop and is not a thing any
// gazetteer holds; left in the string it fails the whole query.
var landmarkWords = []string{
	"beside", "besides", "opp", "opposite", "near", "nearby", "behind",
	"back side", "backside", "next to", "in front of", "above", "below",
}

// geocodeCandidates is the same address said with less and less of it,
// most specific first, capped at three so a lookup stays quick — each
// one is a request to a service that asks for a second between them.
func geocodeCandidates(address string) []string {
	parts := []string{}
	for _, part := range strings.Split(address, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		lower := strings.ToLower(part)
		landmark := false
		for _, word := range landmarkWords {
			if strings.HasPrefix(lower, word+" ") {
				landmark = true
				break
			}
		}
		if !landmark {
			parts = append(parts, part)
		}
	}
	if len(parts) == 0 {
		return []string{address}
	}

	out := []string{}
	seen := map[string]bool{}
	// The whole thing, then the same without its leading segments: a
	// shop name is the part a gazetteer is least likely to know, and the
	// town is the part it always knows.
	for i := 0; i < len(parts) && len(out) < 3; i++ {
		candidate := strings.Join(parts[i:], ", ")
		if !seen[candidate] {
			seen[candidate] = true
			out = append(out, candidate)
		}
	}
	return out
}

func geocode(ctx context.Context, query, viewbox string) ([]geocodeHit, error) {
	key := strings.ToLower(query) + "|" + viewbox

	geocodeMu.Lock()
	if cached, ok := geocodeSeen[key]; ok {
		geocodeMu.Unlock()
		return cached, nil
	}
	if wait := nominatimGap - time.Since(geocodeLast); wait > 0 {
		time.Sleep(wait)
	}
	geocodeLast = time.Now()
	geocodeMu.Unlock()

	params := url.Values{}
	params.Set("q", query)
	params.Set("format", "jsonv2")
	params.Set("limit", "5")
	params.Set("addressdetails", "0")
	if viewbox != "" {
		params.Set("viewbox", viewbox)
	}

	ctx, cancel := context.WithTimeout(ctx, nominatimTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, nominatimURL+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", nominatimAgent)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("nominatim said %d", resp.StatusCode)
	}

	var raw []struct {
		DisplayName string `json:"display_name"`
		Lat         string `json:"lat"`
		Lon         string `json:"lon"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}

	hits := make([]geocodeHit, 0, len(raw))
	for _, item := range raw {
		lat, latErr := strconv.ParseFloat(item.Lat, 64)
		lng, lngErr := strconv.ParseFloat(item.Lon, 64)
		if latErr != nil || lngErr != nil || !validCoordinates(lat, lng) {
			continue
		}
		hits = append(hits, geocodeHit{Label: item.DisplayName, Lat: lat, Lng: lng})
	}

	geocodeMu.Lock()
	geocodeSeen[key] = hits
	geocodeMu.Unlock()
	return hits, nil
}
