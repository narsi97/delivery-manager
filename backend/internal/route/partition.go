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
	// picks through the ordering start the groups spread across the whole
	// delivery area instead of clumped wherever the customer list happened
	// to begin.
	//
	// The sort runs along whichever axis the stops actually spread along,
	// measured in metres so the comparison survives longitude lines
	// crowding together away from the equator. Sorting north-to-south
	// unconditionally reads well but seeds badly for the very ordinary
	// case of a town strung out east-west along a highway: every seed
	// lands in the same end of it, and the split comes back cut across
	// the short axis — two drivers each running the full length of the
	// road instead of taking an end each.
	ordered := make([]Point, len(stops))
	copy(ordered, stops)

	minLat, maxLat := ordered[0].Lat, ordered[0].Lat
	minLng, maxLng := ordered[0].Lng, ordered[0].Lng
	for _, p := range ordered[1:] {
		minLat, maxLat = math.Min(minLat, p.Lat), math.Max(maxLat, p.Lat)
		minLng, maxLng = math.Min(minLng, p.Lng), math.Max(maxLng, p.Lng)
	}
	midLat, midLng := (minLat+maxLat)/2, (minLng+maxLng)/2
	northSouth := DistanceMeters(minLat, midLng, maxLat, midLng)
	eastWest := DistanceMeters(midLat, minLng, midLat, maxLng)

	// Ties break to latitude, so a perfectly square spread — and any set
	// of identical points — still orders the one deterministic way.
	sortByLng := eastWest > northSouth
	sort.SliceStable(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		first, second := a.Lat, b.Lat
		third, fourth := a.Lng, b.Lng
		if sortByLng {
			first, second = a.Lng, b.Lng
			third, fourth = a.Lat, b.Lat
		}
		if first != second {
			return first < second
		}
		if third != fourth {
			return third < fourth
		}
		return a.ID < b.ID
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

// Centroid is the mean position of a set of stops. Empty input returns
// the zero Point, which callers should treat as "no answer" rather than
// as a location — see AssignToFinishes, which only ever calls this on
// groups it already knows are non-empty.
func Centroid(points []Point) Point {
	if len(points) == 0 {
		return Point{}
	}
	var lat, lng float64
	for _, p := range points {
		lat += p.Lat
		lng += p.Lng
	}
	n := float64(len(points))
	return Point{Lat: lat / n, Lng: lng / n}
}

// AssignToFinishes decides which driver takes which group, given where
// each driver finishes their day.
//
// Partition cuts the map into balanced clusters but has no opinion about
// who drives them, and assigning them in arbitrary order is how the
// driver who lives north of town ends up with the southern cluster and a
// long empty drive home. Since a round now ends at the driver's own home
// (see OptimizeReturning and domain.Route.EndLat), that closing leg is
// real distance, and matching it is nearly free.
//
// Pairs are taken greedily in ascending distance from a group's centre to
// a finish point: the single best (group, driver) pairing available is
// committed, then the next best among what is left, and so on. That is
// the same "most constrained first" spirit as assignBalanced — the
// pairing with the most to lose gets to choose first — and unlike a
// per-group nearest-wins loop it cannot have the first group claim the
// home that the second group needed far more.
//
// Deterministic: distances are compared with index tie-breaks, so the
// same drivers and the same stops always produce the same hand-out. An
// admin who re-assigns without changing anything must not get a
// reshuffle.
//
// Returns finish index per group. Extra groups beyond len(finishes) —
// which callers should not produce — are left as -1.
func AssignToFinishes(groups [][]Point, finishes []Point) []int {
	assigned := make([]int, len(groups))
	for i := range assigned {
		assigned[i] = -1
	}
	if len(groups) == 0 || len(finishes) == 0 {
		return assigned
	}

	type pair struct {
		group, finish int
		meters        float64
	}
	pairs := make([]pair, 0, len(groups)*len(finishes))
	for g, group := range groups {
		if len(group) == 0 {
			continue
		}
		centre := Centroid(group)
		for f, finish := range finishes {
			pairs = append(pairs, pair{
				group:  g,
				finish: f,
				meters: DistanceMeters(centre.Lat, centre.Lng, finish.Lat, finish.Lng),
			})
		}
	}

	sort.SliceStable(pairs, func(i, j int) bool {
		if pairs[i].meters != pairs[j].meters {
			return pairs[i].meters < pairs[j].meters
		}
		if pairs[i].group != pairs[j].group {
			return pairs[i].group < pairs[j].group
		}
		return pairs[i].finish < pairs[j].finish
	})

	takenFinish := make([]bool, len(finishes))
	for _, p := range pairs {
		if assigned[p.group] != -1 || takenFinish[p.finish] {
			continue
		}
		assigned[p.group] = p.finish
		takenFinish[p.finish] = true
	}

	// More groups than finishes, or a group whose driver has no home
	// recorded: hand out whatever is left in index order so every group
	// still gets a driver. Ordering by geography stopped being possible
	// the moment there was nothing left to compare against.
	for g := range assigned {
		if assigned[g] != -1 || len(groups[g]) == 0 {
			continue
		}
		for f := range takenFinish {
			if !takenFinish[f] {
				assigned[g], takenFinish[f] = f, true
				break
			}
		}
	}
	return assigned
}

// Cluster groups stops that sit near each other, without being told how
// many groups there are.
//
// Partition answers "cut this into k rounds" — the caller already knows
// k, because k is how many drivers are out. This answers a different
// question: "where does this business actually deliver?", which nobody
// knows in advance and which is the whole difficulty of setting a
// business up. A dairy delivering to one town has one answer; one
// delivering to a town and a village 30km away has two, and neither the
// dairy nor the software knew that before looking.
//
// Single-linkage on a distance threshold, which is the right shape for
// this and not for much else: two stops belong to the same place if you
// can walk between them in hops shorter than linkMeters. Real delivery
// geography is streets and villages — dense blobs separated by empty
// countryside — so a threshold set to "further apart than any two
// neighbouring houses" separates the towns exactly where a human would,
// and never has to guess a group count. k-means with a guessed k would
// happily cut one town in half.
//
// Groups come back largest first, each internally ordered by the input
// order, and stops are never duplicated or dropped.
func Cluster(stops []Point, linkMeters float64) [][]Point {
	if len(stops) == 0 {
		return [][]Point{}
	}

	// Union-find over "within linkMeters of each other". n is the number
	// of pinned customers a single business has, so the quadratic pass is
	// thousands of comparisons at worst — far cheaper than the round
	// optimizer that runs on every day read.
	parent := make([]int, len(stops))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		for parent[i] != i {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	union := func(a, b int) {
		ra, rb := find(a), find(b)
		if ra == rb {
			return
		}
		// Always attach the higher index to the lower, so the
		// representative of a group is its earliest member and the output
		// order cannot depend on iteration order.
		if ra < rb {
			parent[rb] = ra
		} else {
			parent[ra] = rb
		}
	}

	for i := range stops {
		for j := i + 1; j < len(stops); j++ {
			if DistanceMeters(stops[i].Lat, stops[i].Lng, stops[j].Lat, stops[j].Lng) <= linkMeters {
				union(i, j)
			}
		}
	}

	order := []int{}
	members := map[int][]Point{}
	for i, p := range stops {
		root := find(i)
		if _, seen := members[root]; !seen {
			order = append(order, root)
		}
		members[root] = append(members[root], p)
	}

	groups := make([][]Point, 0, len(order))
	for _, root := range order {
		groups = append(groups, members[root])
	}
	// Largest first — the place a business delivers to most is the one
	// worth offering them first. Ties keep input order, so the result is
	// stable across identical calls.
	sort.SliceStable(groups, func(i, j int) bool { return len(groups[i]) > len(groups[j]) })
	return groups
}

// Enclosing reports the centre of a group and how far its furthest member
// sits from that centre — the smallest circle centred on the mean that
// still contains everything. Used to turn a cluster into a service area
// an admin can see and adjust.
func Enclosing(points []Point) (Point, float64) {
	centre := Centroid(points)
	var furthest float64
	for _, p := range points {
		if d := DistanceMeters(centre.Lat, centre.Lng, p.Lat, p.Lng); d > furthest {
			furthest = d
		}
	}
	return centre, furthest
}
