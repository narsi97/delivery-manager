package route

import (
	"math"
	"sort"
)

// Partition splits stops into k geographic groups, one per round.
//
// This is the "I have four drivers today, split the work four ways"
// problem, and it is a different question from ordering one round. The
// two compose: Partition decides who goes where, Optimize decides the
// order within each group. Splitting first and ordering second is what
// makes each round locally tight instead of four drivers criss-crossing
// the same streets.
//
// Two properties matter more here than raw cluster quality:
//
//   - Balance. Plain k-means will happily produce a round of forty stops
//     next to a round of three, because it is minimising distance and
//     nothing else. That is useless for splitting a morning across
//     drivers, so assignment is capped at ceil(n/k) per group and stops
//     are placed most-constrained-first: the stop with the largest gap
//     between its best and second-best group chooses first, since it is
//     the one that loses most by being displaced.
//
//   - Determinism. Same input, same split, every time — an admin who
//     re-plans without changing anything must not get a reshuffle. The
//     seeding is positional rather than random, and every tie breaks on
//     the earlier index.
//
// Groups are returned in a stable order and none of them is empty as
// long as k <= len(stops); callers asking for more rounds than there are
// stops get one round per stop.
func Partition(stops []Point, k int) [][]Point {
	if len(stops) == 0 {
		return [][]Point{}
	}
	if k < 1 {
		k = 1
	}
	if k > len(stops) {
		k = len(stops)
	}
	if k == 1 {
		out := make([]Point, len(stops))
		copy(out, stops)
		return [][]Point{out}
	}

	// Sorting first is what makes the seeding positional: k evenly spaced
	// picks through a north-to-south ordering start the groups spread
	// across the whole delivery area instead of clumped wherever the
	// customer list happened to begin.
	ordered := make([]Point, len(stops))
	copy(ordered, stops)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].Lat != ordered[j].Lat {
			return ordered[i].Lat < ordered[j].Lat
		}
		if ordered[i].Lng != ordered[j].Lng {
			return ordered[i].Lng < ordered[j].Lng
		}
		return ordered[i].ID < ordered[j].ID
	})

	centroids := make([]Point, k)
	for c := 0; c < k; c++ {
		centroids[c] = ordered[c*len(ordered)/k]
	}

	const maxPasses = 50
	capacity := (len(ordered) + k - 1) / k
	assignment := make([]int, len(ordered))
	for i := range assignment {
		assignment[i] = -1
	}

	for pass := 0; pass < maxPasses; pass++ {
		next := assignBalanced(ordered, centroids, capacity)
		if sameAssignment(assignment, next) {
			break
		}
		assignment = next
		centroids = recentre(ordered, assignment, centroids)
	}

	groups := make([][]Point, k)
	for i := range groups {
		groups[i] = []Point{}
	}
	for i, group := range assignment {
		groups[group] = append(groups[group], ordered[i])
	}
	return groups
}

// assignBalanced places every stop in a group, never exceeding capacity.
// Stops are placed in order of how much they stand to lose by not getting
// their first choice — the classic "most constrained first" ordering,
// which keeps the balance cap from evicting the stops that care most.
func assignBalanced(stops []Point, centroids []Point, capacity int) []int {
	type claim struct {
		stop   int
		regret float64
		order  []int // group indices, nearest first
	}

	claims := make([]claim, len(stops))
	for i, stop := range stops {
		distances := make([]float64, len(centroids))
		order := make([]int, len(centroids))
		for c, centroid := range centroids {
			distances[c] = DistanceMeters(stop.Lat, stop.Lng, centroid.Lat, centroid.Lng)
			order[c] = c
		}
		sort.SliceStable(order, func(a, b int) bool { return distances[order[a]] < distances[order[b]] })

		regret := 0.0
		if len(order) > 1 {
			regret = distances[order[1]] - distances[order[0]]
		}
		claims[i] = claim{stop: i, regret: regret, order: order}
	}

	sort.SliceStable(claims, func(a, b int) bool {
		if claims[a].regret != claims[b].regret {
			return claims[a].regret > claims[b].regret
		}
		return claims[a].stop < claims[b].stop
	})

	used := make([]int, len(centroids))
	assignment := make([]int, len(stops))
	for i := range assignment {
		assignment[i] = -1
	}
	for _, c := range claims {
		for _, group := range c.order {
			if used[group] < capacity {
				assignment[c.stop] = group
				used[group]++
				break
			}
		}
	}
	return assignment
}

// recentre moves each centroid to the mean of its members. A group that
// somehow ended up empty keeps its previous centroid rather than
// collapsing to 0,0 in the Gulf of Guinea.
func recentre(stops []Point, assignment []int, previous []Point) []Point {
	sumLat := make([]float64, len(previous))
	sumLng := make([]float64, len(previous))
	count := make([]int, len(previous))

	for i, group := range assignment {
		if group < 0 {
			continue
		}
		sumLat[group] += stops[i].Lat
		sumLng[group] += stops[i].Lng
		count[group]++
	}

	centroids := make([]Point, len(previous))
	for c := range centroids {
		if count[c] == 0 {
			centroids[c] = previous[c]
			continue
		}
		centroids[c] = Point{
			Lat: sumLat[c] / float64(count[c]),
			Lng: sumLng[c] / float64(count[c]),
		}
	}
	return centroids
}

func sameAssignment(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// SpreadMeters reports the largest distance from a group's centre to any
// of its stops — a cheap read on whether a split actually produced tight
// rounds or just cut the map arbitrarily.
func SpreadMeters(group []Point) float64 {
	if len(group) == 0 {
		return 0
	}
	var lat, lng float64
	for _, p := range group {
		lat += p.Lat
		lng += p.Lng
	}
	centre := Point{Lat: lat / float64(len(group)), Lng: lng / float64(len(group))}

	worst := 0.0
	for _, p := range group {
		if d := DistanceMeters(centre.Lat, centre.Lng, p.Lat, p.Lng); d > worst {
			worst = d
		}
	}
	return math.Max(worst, 0)
}
