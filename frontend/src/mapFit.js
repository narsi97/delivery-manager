import L from 'leaflet';

// Where a map should open.
//
// Every map in this app is about a set of places — this day's stops, this
// business's customers, this one pin — so the opening view should be the
// smallest one that shows them all. Getting there is fiddlier than
// fitBounds alone, in three ways that each produced a genuinely bad first
// impression:
//
//   - Service areas are circles, and a circle is kilometres wide. Fitting
//     a layer that contains one meant a business whose customers sit in
//     four adjacent streets opened zoomed out to a 6km ring with the
//     actual work as a speck in the middle. Circles are context; the
//     points are the subject, so only the points decide the view.
//
//   - A single point has no extent, and fitBounds on it slams to maximum
//     zoom — a rooftop, with no clue where in town you are.
//
//   - A tight cluster has almost no extent either, so fitting it exactly
//     lands somewhere near maximum zoom for the same reason.
//
// Nothing at all to show still falls back to the country view, but that
// is now only what a brand-new business with no pins anywhere sees.
const FALLBACK_CENTER = [20.5937, 78.9629]; // roughly the centre of India
const FALLBACK_ZOOM = 5;

// Close enough to read street names, wide enough to recognise the
// neighbourhood. Used for a lone point, and as the ceiling when a cluster
// is so tight that fitting it exactly would be useless.
const SINGLE_POINT_ZOOM = 15;
const MAX_FIT_ZOOM = 16;

// points: [{lat, lng}] — the things the map is actually about.
// fallbackBounds: an optional L.LatLngBounds to use when there are no
// points at all (service-area circles, say), so a business that has drawn
// where it delivers but not yet pinned anyone still opens somewhere
// useful.
export function fitToPoints(map, points, { padding = 30, fallbackBounds = null } = {}) {
  const valid = (points || []).filter(
    (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && (p.lat !== 0 || p.lng !== 0)
  );

  if (valid.length === 1) {
    map.setView([valid[0].lat, valid[0].lng], SINGLE_POINT_ZOOM);
    return true;
  }

  if (valid.length > 1) {
    const bounds = L.latLngBounds(valid.map((p) => [p.lat, p.lng]));
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [padding, padding], maxZoom: MAX_FIT_ZOOM });
      return true;
    }
  }

  if (fallbackBounds && fallbackBounds.isValid()) {
    map.fitBounds(fallbackBounds, { padding: [padding, padding], maxZoom: MAX_FIT_ZOOM });
    return true;
  }

  map.setView(FALLBACK_CENTER, FALLBACK_ZOOM);
  return false;
}
