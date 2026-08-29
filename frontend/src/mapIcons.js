import L from 'leaflet';

import { colors } from './theme';

// The four things a delivery business has on a map, drawn so they can be
// told apart at a glance rather than by clicking each one.
//
// Inline SVG data URIs, not Leaflet's bundled PNGs — those resolve to a
// relative image path that assumes a webpack/CRA asset pipeline, which
// Metro doesn't serve at the same URL, and the symptom is a broken-image
// marker. A data: URI has no path to get wrong, and img-src already
// allows data: under the shared Caddy's CSP.
//
// Shape *and* colour both carry the meaning. Either alone is a bad bet:
// colour fails for anyone who doesn't separate these hues, and shape
// alone is hard to read at the size a hundred markers have to be. So a
// driver is a blue cap, a customer is a pink pin, the business is a dark
// house, and no two share a silhouette.

// Deliberately not from theme.js. These are map symbols, not UI chrome —
// they have to hold up against OpenStreetMap's own beige-and-green tiles,
// which the app's palette was never chosen for.
export const MAP_COLORS = {
  driver: '#1d6fd0', // blue
  customer: '#e0409a', // pink
  business: '#111827', // near-black, so the one house reads as the anchor
};

function icon(svg, size, anchor) {
  return L.icon({
    iconUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    iconSize: size,
    iconAnchor: anchor || [size[0] / 2, size[1] / 2],
  });
}

// The business itself. A house with a door — the "home" mark everyone
// already reads as home — on a white disc so it stays legible over dark
// tiles, and the largest symbol on the map because there is exactly one
// of it and it anchors everything else.
export const homeIcon = icon(
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
    <circle cx="20" cy="20" r="17" fill="#fff" stroke="${MAP_COLORS.business}" stroke-width="2.5"/>
    <path d="M20 9 L31 19.5 H28 V30 H12 V19.5 H9 Z" fill="${MAP_COLORS.business}"/>
    <rect x="17" y="23" width="6" height="7" rx="0.8" fill="#fff"/>
  </svg>`,
  [40, 40]
);

// Where a driver finishes. A peaked cap — what a delivery rider is
// wearing — in blue, which is the one hue on this map that never means
// anything else.
export const driverIcon = icon(
  `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">
    <circle cx="17" cy="17" r="15" fill="#fff" stroke="${MAP_COLORS.driver}" stroke-width="2.5"/>
    <path d="M9.5 19.5 C9.5 13 12.5 10 17 10 C21.5 10 24.5 13 24.5 19.5 Z" fill="${MAP_COLORS.driver}"/>
    <path d="M7.5 19.5 H26.5 C27.3 19.5 27.7 20.6 27 21.3 L25.8 22.4 H8.2 L7 21.3 C6.3 20.6 6.7 19.5 7.5 19.5 Z" fill="${MAP_COLORS.driver}"/>
  </svg>`,
  [34, 34]
);

// A customer's door, as a pink pin. Small, because there are a hundred of
// these against two of everything else and they have to read as the
// texture of the round rather than compete with the marks that anchor it.
// Anchored at the tip, since that is the bit pointing at the address.
export const customerIcon = icon(
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="25" viewBox="0 0 18 25">
    <path d="M9 0C4 0 0 4 0 9c0 6.3 9 16 9 16s9-9.7 9-16c0-5-4-9-9-9z" fill="${MAP_COLORS.customer}" stroke="#fff" stroke-width="1.2"/>
    <circle cx="9" cy="9" r="3.2" fill="#fff"/>
  </svg>`,
  [18, 25],
  [9, 25]
);

// The pin being placed right now — the app's own accent, so "the thing
// you are moving" never gets confused with "a customer who is already
// there". Full size, because it is the one you are aiming.
export const activePinIcon = icon(
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">
    <path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 27 15 27s15-16.5 15-27C30 6.7 23.3 0 15 0z" fill="${colors.accent}" stroke="#fff" stroke-width="1.5"/>
    <circle cx="15" cy="15" r="6" fill="#fff"/>
  </svg>`,
  [30, 42],
  [15, 42]
);
