package route

import (
	"fmt"
	"testing"
)

// A line of stops split in two should cut the line once, not interleave
// the two rounds along it — the whole point of splitting geographically
// is that two drivers don't drive the same street.
func TestPartitionSplitsALineIntoContiguousHalves(t *testing.T) {
	stops := []Point{}
	for i := 0; i < 10; i++ {
		stops = append(stops, Point{ID: fmt.Sprintf("s%d", i), Lat: 12.90 + float64(i)*0.01, Lng: 77.59})
	}

	groups := Partition(stops, 2)
	if len(groups) != 2 {
		t.Fatalf("got %d groups, want 2", len(groups))
	}

	// Every stop in one group must sit entirely north or entirely south
	// of every stop in the other.
	maxA, minA := -999.0, 999.0
	for _, p := range groups[0] {
		if p.Lat > maxA {
			maxA = p.Lat
		}
		if p.Lat < minA {
			minA = p.Lat
		}
	}
	for _, p := range groups[1] {
		if p.Lat > minA && p.Lat < maxA {
			t.Fatalf("group 1 stop at %.4f falls inside group 0's range %.4f..%.4f — the split interleaves", p.Lat, minA, maxA)
		}
	}
}

// Balance is the reason this exists rather than plain k-means: splitting
// a morning across drivers is useless if one of them gets forty stops and
// another gets three.
func TestPartitionKeepsGroupsBalanced(t *testing.T) {
	// Deliberately lopsided geography: a dense cluster and one outlier.
	stops := []Point{}
	for i := 0; i < 20; i++ {
		stops = append(stops, Point{ID: fmt.Sprintf("dense%d", i), Lat: 12.90 + float64(i)*0.0001, Lng: 77.59})
	}
	stops = append(stops, Point{ID: "far", Lat: 13.20, Lng: 77.59})

	groups := Partition(stops, 3)
	capacity := (len(stops) + 2) / 3
	for i, g := range groups {
		if len(g) == 0 {
			t.Fatalf("group %d is empty; a requested round must get work", i)
		}
		if len(g) > capacity {
			t.Fatalf("group %d has %d stops, over the %d cap — the split is unbalanced", i, len(g), capacity)
		}
	}
}

func TestPartitionIsDeterministic(t *testing.T) {
	stops := []Point{}
	for i := 0; i < 25; i++ {
		stops = append(stops, Point{ID: fmt.Sprintf("s%d", i), Lat: 12.90 + float64(i%7)*0.01, Lng: 77.59 + float64(i%5)*0.01})
	}

	first := Partition(stops, 4)
	for attempt := 0; attempt < 5; attempt++ {
		again := Partition(stops, 4)
		for g := range first {
			if len(first[g]) != len(again[g]) {
				t.Fatalf("group %d size changed between runs: %d then %d", g, len(first[g]), len(again[g]))
			}
			for i := range first[g] {
				if first[g][i].ID != again[g][i].ID {
					t.Fatalf("group %d position %d changed between runs: %s then %s", g, i, first[g][i].ID, again[g][i].ID)
				}
			}
		}
	}
}

func TestPartitionPreservesEveryStop(t *testing.T) {
	stops := []Point{}
	for i := 0; i < 17; i++ {
		stops = append(stops, Point{ID: fmt.Sprintf("s%d", i), Lat: 12.90 + float64(i)*0.003, Lng: 77.59 + float64(i%3)*0.004})
	}

	for k := 1; k <= 10; k++ {
		seen := map[string]int{}
		for _, group := range Partition(stops, k) {
			for _, p := range group {
				seen[p.ID]++
			}
		}
		if len(seen) != len(stops) {
			t.Fatalf("k=%d: %d distinct stops came back, want %d", k, len(seen), len(stops))
		}
		for id, n := range seen {
			if n != 1 {
				t.Fatalf("k=%d: stop %s appears %d times, want exactly once", k, id, n)
			}
		}
	}
}

// Asking for more rounds than there are stops is a thing an admin can do
// with a 1..10 picker and three customers. It must degrade to one stop
// per round rather than producing empty rounds.
func TestPartitionCapsGroupsAtStopCount(t *testing.T) {
	stops := []Point{
		{ID: "a", Lat: 12.90, Lng: 77.59},
		{ID: "b", Lat: 12.91, Lng: 77.59},
		{ID: "c", Lat: 12.92, Lng: 77.59},
	}
	groups := Partition(stops, 10)
	if len(groups) != 3 {
		t.Fatalf("got %d groups for 3 stops, want 3", len(groups))
	}
	for i, g := range groups {
		if len(g) != 1 {
			t.Fatalf("group %d has %d stops, want 1", i, len(g))
		}
	}
}

// Sending the driver home changes which order is cheapest — that is the
// whole reason it is a separate call and not a number added at the end.
func TestOptimizeReturningCountsTheDriveHome(t *testing.T) {
	start := Point{Lat: 12.90, Lng: 77.59}
	stops := []Point{
		{ID: "near", Lat: 12.91, Lng: 77.59},
		{ID: "far", Lat: 12.95, Lng: 77.59},
	}

	_, openMeters := Optimize(start, stops)
	_, loopMeters := OptimizeReturning(start, stops, start)

	if loopMeters <= openMeters {
		t.Fatalf("round trip measured %.0fm, not more than the one-way %.0fm — the drive home isn't being counted", loopMeters, openMeters)
	}

	// Depot -> near -> far -> depot is 1+4+5 units of 0.01 degrees.
	// Anything shorter means a leg is being dropped.
	oneUnit := DistanceMeters(12.90, 77.59, 12.91, 77.59)
	want := oneUnit * 10
	if diff := loopMeters - want; diff > 1 || diff < -1 {
		t.Fatalf("round trip measured %.1fm, want about %.1fm", loopMeters, want)
	}
}

func TestOptimizeReturningVisitsEveryStopOnce(t *testing.T) {
	start := Point{Lat: 12.90, Lng: 77.59}
	stops := []Point{}
	for i := 0; i < 12; i++ {
		stops = append(stops, Point{ID: fmt.Sprintf("s%d", i), Lat: 12.90 + float64(i%4)*0.01, Lng: 77.59 + float64(i%3)*0.01})
	}

	ordered, _ := OptimizeReturning(start, stops, start)
	if len(ordered) != len(stops) {
		t.Fatalf("got %d stops back, want %d", len(ordered), len(stops))
	}
	seen := map[string]bool{}
	for _, p := range ordered {
		if seen[p.ID] {
			t.Fatalf("stop %s appears twice", p.ID)
		}
		seen[p.ID] = true
	}
}

// A town strung out east-west along a highway is as ordinary as one that
// runs north-south, and the split has to cut across the long axis in both
// cases. Seeding always ran north-to-south once, which put every seed in
// the same end of an east-west town and handed both drivers the full
// length of the road.
func TestPartitionSplitsAnEastWestLineIntoContiguousHalves(t *testing.T) {
	stops := []Point{}
	for i := 0; i < 10; i++ {
		stops = append(stops, Point{ID: fmt.Sprintf("s%d", i), Lat: 12.90, Lng: 77.55 + float64(i)*0.01})
	}

	groups := Partition(stops, 2)
	if len(groups) != 2 {
		t.Fatalf("got %d groups, want 2", len(groups))
	}

	maxA, minA := -999.0, 999.0
	for _, p := range groups[0] {
		if p.Lng > maxA {
			maxA = p.Lng
		}
		if p.Lng < minA {
			minA = p.Lng
		}
	}
	for _, p := range groups[1] {
		if p.Lng > minA && p.Lng < maxA {
			t.Fatalf("group 1 stop at %.4f falls inside group 0's range %.4f..%.4f — the split interleaves", p.Lng, minA, maxA)
		}
	}
}

// AssignToFinishes exists so the driver who lives at one end of the round
// is given that end, rather than the clusters being handed out in
// whatever order they were cut.
func TestAssignToFinishesGivesEachDriverTheirNearestCluster(t *testing.T) {
	west := []Point{{ID: "w1", Lat: 12.90, Lng: 77.50}, {ID: "w2", Lat: 12.91, Lng: 77.51}}
	east := []Point{{ID: "e1", Lat: 12.90, Lng: 77.70}, {ID: "e2", Lat: 12.91, Lng: 77.71}}

	// Finishes deliberately in the opposite order to the groups, so an
	// implementation that just paired them off by index would fail.
	finishes := []Point{{Lat: 12.90, Lng: 77.72}, {Lat: 12.90, Lng: 77.48}}

	got := AssignToFinishes([][]Point{west, east}, finishes)
	if got[0] != 1 {
		t.Fatalf("west cluster went to finish %d, want 1 (the western home)", got[0])
	}
	if got[1] != 0 {
		t.Fatalf("east cluster went to finish %d, want 0 (the eastern home)", got[1])
	}
}

// Every group gets exactly one driver, and no driver gets two — the
// whole point of matching rather than nearest-wins per group.
func TestAssignToFinishesIsAOneToOneMatching(t *testing.T) {
	groups := [][]Point{
		{{ID: "a", Lat: 12.90, Lng: 77.50}},
		{{ID: "b", Lat: 12.91, Lng: 77.51}},
		{{ID: "c", Lat: 12.92, Lng: 77.52}},
	}
	// All three homes crowded together, so a naive per-group nearest-wins
	// would hand the same one out repeatedly.
	finishes := []Point{
		{Lat: 12.90, Lng: 77.5000},
		{Lat: 12.90, Lng: 77.5001},
		{Lat: 12.90, Lng: 77.5002},
	}

	got := AssignToFinishes(groups, finishes)
	seen := map[int]bool{}
	for g, f := range got {
		if f < 0 {
			t.Fatalf("group %d got no driver", g)
		}
		if seen[f] {
			t.Fatalf("driver %d was given more than one group", f)
		}
		seen[f] = true
	}
}
