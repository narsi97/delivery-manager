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
// Shapes carry the meaning, not just colour: a business owner glancing at
// this needs "that's the dairy, those are my drivers, those are
// customers" without a legend lookup, and colour alone fails that for
// anyone who doesn't distinguish red from green.

function icon(svg, size, anchor) {
  return L.icon({
    iconUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    iconSize: size,
    iconAnchor: anchor || [size[0] / 2, size[1] / 2],
  });
}

// The business itself — a house, because that is what "home location"
// means to the person setting it.
export const homeIcon = icon(
  `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">
    <circle cx="17" cy="17" r="15" fill="#fff" stroke="${colors.text}" stroke-width="2.5"/>
    <path d="M17 8 L26 16 H23.5 V25 H18.5 V19.5 H15.5 V25 H10.5 V16 H8 Z" fill="${colors.text}"/>
  </svg>`,
  [34, 34]
);

// A driver's own home, where their route finishes — a peaked cap, the
// thing a delivery rider is wearing.
export const driverIcon = icon(
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="14" fill="#fff" stroke="${colors.accent}" stroke-width="2.5"/>
    <path d="M9 18 C9 12 12 9.5 16 9.5 C20 9.5 23 12 23 18 Z" fill="${colors.accent}"/>
    <path d="M7.5 18 H24.5 C25.2 18 25.6 19 25 19.6 L24 20.5 H8 L7 19.6 C6.4 19 6.8 18 7.5 18 Z" fill="${colors.accent}"/>
  </svg>`,
  [32, 32]
);

// A customer's door. Small and plain on purpose — there are a hundred of
// these and two of everything else, so they must read as background
// texture rather than compete with the pins that matter.
export const customerIcon = icon(
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">
    <circle cx="7" cy="7" r="5" fill="${colors.subtitle}" stroke="#fff" stroke-width="2"/>
  </svg>`,
  [14, 14]
);

// A customer with no pin can't be drawn at all, so this is for the
// opposite case: the one being placed right now, which stays a teardrop
// so it reads as "this is the thing you are moving".
export const activePinIcon = icon(
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">
    <path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 27 15 27s15-16.5 15-27C30 6.7 23.3 0 15 0z" fill="${colors.accent}"/>
    <circle cx="15" cy="15" r="6" fill="#fff"/>
  </svg>`,
  [30, 42],
  [15, 42]
);

// What each symbol means, for the legend the maps render underneath
// themselves. Kept here so the drawing and the explaining can't drift.
export const MAP_LEGEND = [
  { key: 'home', label: 'Your business', shape: 'house' },
  { key: 'driver', label: 'Driver finishes here', shape: 'cap' },
  { key: 'customer', label: 'Customer', shape: 'dot' },
  { key: 'area', label: 'Service area', shape: 'circle' },
];
