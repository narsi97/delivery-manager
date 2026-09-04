package httpapi

import (
	"testing"

	"delivery-manager/internal/route"
)

func points(n int) []route.Point {
	out := make([]route.Point, n)
	for i := range out {
		out[i] = route.Point{ID: string(rune('a' + i))}
	}
	return out
}

func addresses(list ...string) ([]route.Point, map[string]string) {
	pts := points(len(list))
	m := map[string]string{}
	for i, a := range list {
		m[pts[i].ID] = a
	}
	return pts, m
}

// The list this app was first handed for a real business: free text, no
// commas, the town at the end in whatever case the typist used.
func TestPlaceNameFromFreeTextAddresses(t *testing.T) {
	pts, addr := addresses(
		"H No : 5-2-5 Lateefsab dargha khamman near clocktower nalgonda",
		"H No : 4-6-32 Ibrahim masjid akka sharma ward no 26 nalgonda",
		"H No : 6-1-115 opp Sbr gardens function hall boyawada Busstand back side Nalgonda",
		"Plot no 11 Nandishwar colony pangal road BSNL bhavan Nalgonda",
	)
	if got := placeNameFor(pts, addr); got != "nalgonda" {
		t.Errorf("placeNameFor = %q, want the town every address ends with", got)
	}
}

// Tidy comma-separated addresses still win on the comma, which is a
// deliberate mark where a space is not.
func TestPlaceNamePrefersCommaWhenThereIsOne(t *testing.T) {
	pts, addr := addresses(
		"39, Clock Tower, Nalgonda",
		"12, NG College Road, Nalgonda",
		"7, Prakasham Bazar, Nalgonda",
	)
	if got := placeNameFor(pts, addr); got != "Nalgonda" {
		t.Errorf("placeNameFor = %q, want Nalgonda", got)
	}
}

// A trailing comma is common and means nothing.
func TestPlaceNameIgnoresTrailingComma(t *testing.T) {
	pts, addr := addresses(
		"Plot no 301, Ravinder Nagar Colony, Nalgonda,",
		"Plot no 88, Shivaram Nagar, Nalgonda,",
		"Plot no 2, Gandhi Nagar, Nalgonda,",
	)
	if got := placeNameFor(pts, addr); got != "Nalgonda" {
		t.Errorf("placeNameFor = %q, want Nalgonda", got)
	}
}

// The same town typed two ways is still one town. Counting the spellings
// apart is what turns a clear majority into two losing halves.
func TestPlaceNameIgnoresCase(t *testing.T) {
	pts, addr := addresses(
		"near clocktower nalgonda",
		"near busstand Nalgonda",
		"near the college NALGONDA",
		"beside the school Nalgonda",
	)
	got := placeNameFor(pts, addr)
	if got != "nalgonda" {
		t.Errorf("placeNameFor = %q, want the first spelling seen", got)
	}
}

// A cluster that agrees on nothing gets no name, rather than a
// confidently wrong one. This is what the free-text fallback must not
// break: every address ending in a different word is not a locality.
func TestPlaceNameStaysEmptyWhenNobodyAgrees(t *testing.T) {
	pts, addr := addresses(
		"beside the temple",
		"opposite the school",
		"near the hospital",
		"behind the market",
	)
	if got := placeNameFor(pts, addr); got != "" {
		t.Errorf("placeNameFor = %q, want empty when the cluster agrees on nothing", got)
	}
}

// A whole free-text address is not a locality just because it has no
// commas in it — the comma rule must decline rather than return the lot.
func TestPlaceNameRejectsAWholeAddressAsALocality(t *testing.T) {
	long := "H No : 8-2-143/3/2 Government hospital near sonalika tractor show room beside deepthi paramedical"
	pts, addr := addresses(long, long, long)
	if got := placeNameFor(pts, addr); got == long {
		t.Errorf("placeNameFor returned the whole address as a place name")
	}
}
