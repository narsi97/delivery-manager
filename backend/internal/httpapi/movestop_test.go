package httpapi

import (
	"net/http"
	"testing"
)

// stopOnRoute returns one stop id sitting on the given round, plus the
// day payload it came from.
func stopOnRoute(t *testing.T, day map[string]any, routeID string) string {
	t.Helper()
	for _, stop := range stopsOf(t, day) {
		if str(stop, "route_id") == routeID {
			return str(stop, "id")
		}
	}
	t.Fatalf("no stop found on route %s", routeID)
	return ""
}

func routeIDs(t *testing.T, day map[string]any) []string {
	t.Helper()
	routes, _ := day["routes"].([]any)
	out := []string{}
	for _, raw := range routes {
		out = append(out, str(raw.(map[string]any), "id"))
	}
	return out
}

func countOnRoute(t *testing.T, day map[string]any, routeID string) int {
	t.Helper()
	n := 0
	for _, stop := range stopsOf(t, day) {
		if str(stop, "route_id") == routeID {
			n++
		}
	}
	return n
}

// The automatic split knows where the pins are; it doesn't know local
// knowledge. An admin looking at the map must be able to move a stop to
// another round and have it stick.
func TestMoveStopBetweenRounds(t *testing.T) {
	admin := planSetup(t, 10)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 2}, http.StatusOK)

	ids := routeIDs(t, day)
	from, to := ids[0], ids[1]
	beforeFrom, beforeTo := countOnRoute(t, day, from), countOnRoute(t, day, to)
	moving := stopOnRoute(t, day, from)

	after := admin.mustDo(http.MethodPatch, "/api/v1/orders/"+moving+"/route",
		map[string]any{"route_id": to}, http.StatusOK)

	if got := countOnRoute(t, after, from); got != beforeFrom-1 {
		t.Fatalf("source round has %d stops, want %d", got, beforeFrom-1)
	}
	if got := countOnRoute(t, after, to); got != beforeTo+1 {
		t.Fatalf("target round has %d stops, want %d", got, beforeTo+1)
	}

	for _, stop := range stopsOf(t, after) {
		if str(stop, "id") == moving && str(stop, "route_id") != to {
			t.Fatalf("moved stop is on round %s, want %s", str(stop, "route_id"), to)
		}
	}
}

// Moving a stop must leave both rounds drivable, which means re-ordering
// them — a stop dropped into the middle of someone else's round is only
// useful if the sequence still makes sense.
func TestMoveStopResequencesBothRounds(t *testing.T) {
	admin := planSetup(t, 10)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 2}, http.StatusOK)

	ids := routeIDs(t, day)
	from, to := ids[0], ids[1]
	moving := stopOnRoute(t, day, from)

	after := admin.mustDo(http.MethodPatch, "/api/v1/orders/"+moving+"/route",
		map[string]any{"route_id": to}, http.StatusOK)

	for _, routeID := range []string{from, to} {
		seen := map[float64]bool{}
		count := 0
		for _, stop := range stopsOf(t, after) {
			if str(stop, "route_id") != routeID {
				continue
			}
			seq := num(stop, "sequence")
			if seq < 1 {
				t.Fatalf("round %s has a stop with sequence %v — every routed stop must be sequenced", routeID, seq)
			}
			if seen[seq] {
				t.Fatalf("round %s has two stops at sequence %v", routeID, seq)
			}
			seen[seq] = true
			count++
		}
		if len(seen) != count {
			t.Fatalf("round %s has %d stops but %d distinct sequences", routeID, count, len(seen))
		}
	}
}

// An empty route_id takes the stop off every round rather than moving it,
// which is how an admin parks something they want to deal with by hand.
func TestMoveStopOffEveryRound(t *testing.T) {
	admin := planSetup(t, 6)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 2}, http.StatusOK)

	from := routeIDs(t, day)[0]
	moving := stopOnRoute(t, day, from)

	after := admin.mustDo(http.MethodPatch, "/api/v1/orders/"+moving+"/route",
		map[string]any{"route_id": ""}, http.StatusOK)

	summary, _ := after["summary"].(map[string]any)
	if got := num(summary, "unrouted"); got != 1 {
		t.Fatalf("unrouted = %v after parking a stop, want 1", got)
	}
	for _, stop := range stopsOf(t, after) {
		if str(stop, "id") == moving && str(stop, "route_id") != "" {
			t.Fatalf("parked stop is still on round %s", str(stop, "route_id"))
		}
	}
}

// A completed delivery's round is the record of where it was actually
// made. Moving it would rewrite history.
func TestMoveCompletedStopIsRefused(t *testing.T) {
	admin := planSetup(t, 6)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 2}, http.StatusOK)

	ids := routeIDs(t, day)
	moving := stopOnRoute(t, day, ids[0])
	admin.mustDo(http.MethodPatch, "/api/v1/orders/"+moving,
		map[string]any{"status": "delivered"}, http.StatusOK)

	admin.mustDo(http.MethodPatch, "/api/v1/orders/"+moving+"/route",
		map[string]any{"route_id": ids[1]}, http.StatusBadRequest)
}

// Rounds are per-day. Moving a stop onto another day's round would put a
// delivery somewhere nobody is driving.
func TestMoveStopToAnotherDaysRoundIsRefused(t *testing.T) {
	admin := planSetup(t, 6)
	today := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 1}, http.StatusOK)
	date := str(today, "date")

	tomorrow, err := shiftDate(date, 1)
	if err != nil {
		t.Fatalf("shift date: %v", err)
	}
	// Reading the day is what materializes it — tomorrow has no
	// deliveries to plan until something asks for tomorrow.
	admin.mustDo(http.MethodGet, "/api/v1/day?date="+tomorrow, nil, http.StatusOK)
	next := admin.mustDo(http.MethodPost, "/api/v1/routes/plan",
		map[string]any{"count": 1, "date": tomorrow}, http.StatusOK)
	tomorrowRound := routeIDs(t, next)[0]

	moving := stopOnRoute(t, today, routeIDs(t, today)[0])
	admin.mustDo(http.MethodPatch, "/api/v1/orders/"+moving+"/route",
		map[string]any{"route_id": tomorrowRound}, http.StatusBadRequest)
}

// A stop that is already unrouted can be placed onto a round from the map
// — that is the other half of "verify the assignments".
func TestMoveUnroutedStopOntoARound(t *testing.T) {
	admin := planSetup(t, 6)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 2}, http.StatusOK)

	from := routeIDs(t, day)[0]
	moving := stopOnRoute(t, day, from)
	parked := admin.mustDo(http.MethodPatch, "/api/v1/orders/"+moving+"/route",
		map[string]any{"route_id": ""}, http.StatusOK)

	to := routeIDs(t, parked)[1]
	before := countOnRoute(t, parked, to)

	after := admin.mustDo(http.MethodPatch, "/api/v1/orders/"+moving+"/route",
		map[string]any{"route_id": to}, http.StatusOK)

	if got := countOnRoute(t, after, to); got != before+1 {
		t.Fatalf("target round has %d stops, want %d", got, before+1)
	}
	summary, _ := after["summary"].(map[string]any)
	if got := num(summary, "unrouted"); got != 0 {
		t.Fatalf("unrouted = %v, want 0", got)
	}
}

// Creating an empty round is the other half of moving stops from the map:
// an admin adds "Evening round", then moves the late customers onto it.
// Without allow_empty a new round can only be made while unrouted work
// happens to exist, which is exactly when you least need one.
func TestCreateEmptyRoundThenMoveStopsOntoIt(t *testing.T) {
	admin := planSetup(t, 6)
	day := admin.mustDo(http.MethodPost, "/api/v1/routes/plan", map[string]any{"count": 1}, http.StatusOK)
	full := routeIDs(t, day)[0]

	// Everything is routed, so this would be a 400 without allow_empty.
	admin.mustDo(http.MethodPost, "/api/v1/routes", map[string]any{
		"name": "Evening round", "start_lat": 12.9700, "start_lng": 77.5946, "allow_empty": true,
	}, http.StatusOK)

	after := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	var evening string
	for _, raw := range after["routes"].([]any) {
		rt := raw.(map[string]any)
		if str(rt, "name") == "Evening round" {
			evening = str(rt, "id")
		}
	}
	if evening == "" {
		t.Fatal("the empty round was not created")
	}
	if got := countOnRoute(t, after, evening); got != 0 {
		t.Fatalf("new round has %d stops, want 0", got)
	}

	moving := stopOnRoute(t, after, full)
	moved := admin.mustDo(http.MethodPatch, "/api/v1/orders/"+moving+"/route",
		map[string]any{"route_id": evening}, http.StatusOK)
	if got := countOnRoute(t, moved, evening); got != 1 {
		t.Fatalf("after moving one stop the new round has %d, want 1", got)
	}
}
