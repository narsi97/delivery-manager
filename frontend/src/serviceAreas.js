// Pure geometry for grouping customers/stops by which service area they
// fall in. Mirrors backend/internal/route.DistanceMeters (haversine) —
// there's no shared code between the Go backend and this frontend today,
// same as MapPicker.web.js's pin icon being its own self-contained thing.
const EARTH_RADIUS_METERS = 6371000;

export function distanceMeters(aLat, aLng, bLat, bLng) {
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, h)));
}

// serviceRouteOfRoute is which service route a day's route was prepared
// for. Mirrors serviceRouteOf in backend/internal/httpapi/admin.go.
//
// The stored link wins; the start point is only a fallback for routes
// prepared before routes carried one. Two service routes over the same
// streets share a centre exactly, so the coordinates genuinely cannot
// tell them apart — which is why the link exists.
export function serviceRouteOfRoute(route, areas) {
  if (route?.service_area_id) {
    return (areas || []).find((area) => area.id === route.service_area_id && area.active) || null;
  }
  return nearestAreaFor(route?.start_lat, route?.start_lng, areas);
}

// serviceRouteFor is which service route a customer belongs to: the one
// they were put on by hand, or failing that the one whose circle covers
// their pin.
//
// Mirrors areaForCustomer in backend/internal/httpapi/admin.go. The two
// must agree — the group an admin sees a customer under here is supposed
// to be the round that customer actually lands on.
export function serviceRouteFor(customer, areas) {
  if (customer?.service_area_id) {
    const pinned = (areas || []).find((area) => area.id === customer.service_area_id && area.active);
    if (pinned) {
      return pinned;
    }
  }
  if (!customer || (!customer.lat && !customer.lng)) {
    return null;
  }
  return nearestAreaFor(customer.lat, customer.lng, areas);
}

// nearestAreaFor returns the active service area whose circle contains
// (lat, lng), nearest-center-wins on overlap, or null if the point falls
// outside every circle (or there are no areas at all). Ties break on list
// order — the API returns areas sorted by name, same "earlier index wins"
// determinism route.Optimize's nearestNeighbour uses for co-located pins.
export function nearestAreaFor(lat, lng, areas) {
  let best = null;
  let bestDist = Infinity;
  for (const area of areas || []) {
    if (!area.active) {
      continue;
    }
    const d = distanceMeters(lat, lng, area.lat, area.lng);
    if (d <= area.radius_meters && d < bestDist) {
      best = area;
      bestDist = d;
    }
  }
  return best;
}
