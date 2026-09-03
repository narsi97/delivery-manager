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
//   - One customer far out of town drags the view out to district scale
//     and squashes the actual round into a speck. A dairy with
//     twenty-five stops in Nalgonda and one in Miryalaguda opened on a
//     map where the twenty-five were a single dot. So the view frames
//     the bulk of the work and lets a genuine outlier sit off-screen —
//     it is still on the map, one pinch away, and the screen says so
//     rather than pretending it isn't there. See outlierAwareBounds.
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

// How far past the crowd a point has to sit before it stops deciding the
// view. Measured against the spread of the middle of the pack, so it
// scales with the business: a city dairy and one delivering across three
// towns both get a sensible answer, and a genuinely even spread has no
// outliers at all.
const OUTLIER_FACTOR = 3;
// Below this, "outlier" is not a meaningful idea — with four stops, the
// far one is a quarter of the work and belongs on screen.
const MIN_POINTS_FOR_OUTLIERS = 8;

function median(sorted) {
  if (sorted.length === 0) {
    return 0;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The points that should decide the view, and the ones left off it.
//
// Distance is measured in degrees rather than metres on purpose: this is
// about how much of the *screen* a point demands, and the fit is in
// lat/lng. The median centre is used rather than the mean because the
// mean is dragged by the very points being looked for.
export function splitOutliers(points) {
  if (points.length < MIN_POINTS_FOR_OUTLIERS) {
    return { core: points, outliers: [] };
  }
  const centre = {
    lat: median([...points.map((p) => p.lat)].sort((a, b) => a - b)),
    lng: median([...points.map((p) => p.lng)].sort((a, b) => a - b)),
  };
  const spread = points.map((p) => Math.hypot(p.lat - centre.lat, p.lng - centre.lng));
  const typical = median([...spread].sort((a, b) => a - b));
  // Everyone on top of each other: no spread to compare against, so
  // nothing is an outlier and the ordinary fit is already right.
  if (typical <= 0) {
    return { core: points, outliers: [] };
  }
  const limit = typical * OUTLIER_FACTOR;
  const core = points.filter((p, i) => spread[i] <= limit);
  const outliers = points.filter((p, i) => spread[i] > limit);
  // Never zoom to nothing, and never call most of the map an exception.
  if (core.length < points.length / 2) {
    return { core: points, outliers: [] };
  }
  return { core, outliers };
}

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
    const { core } = splitOutliers(valid);
    const bounds = L.latLngBounds((core.length > 1 ? core : valid).map((p) => [p.lat, p.lng]));
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
