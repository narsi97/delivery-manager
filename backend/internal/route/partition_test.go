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
