// Turning a shared map link into a pin.
//
// This is how people actually pass a location around here: someone sends
// a Google Maps link on WhatsApp and the admin has it on their phone.
// Asking them to read latitude and longitude off it and retype two
// fifteen-character decimals is the kind of thing software asks and
// people don't do.
//
// Pure string work, no network. That is a deliberate limit rather than
// an oversight — see SHORT_LINK_HOSTS below.

import { decodePlusCode, looksLikePlusCode } from './plusCodes';

const COORD = String.raw`(-?\d{1,3}(?:\.\d+)?)`;

// Ordered most-specific first: a place URL contains both an @-pair and
// sometimes a q= parameter, and the @-pair is the one that points at the
// place rather than at the search that found it.
const PATTERNS = [
  // .../maps/@17.0575,79.2671,15z  and  .../maps/place/Name/@17.05,79.26,17z
  new RegExp(String.raw`/@${COORD},${COORD}`),
  // ?q=17.05,79.26  ?query=17.05,79.26  ?ll=17.05,79.26  ?destination=…
  new RegExp(String.raw`[?&](?:q|query|ll|sll|daddr|destination|center)=${COORD},\s*${COORD}`, 'i'),
  // openstreetmap.org/#map=17/17.05/79.26
  new RegExp(String.raw`#map=\d+(?:\.\d+)?/${COORD}/${COORD}`),
  // geo:17.05,79.26  — what an Android "share location" intent produces
  new RegExp(String.raw`^geo:${COORD},${COORD}`, 'i'),
  // A bare pair, pasted from anywhere at all.
  new RegExp(String.raw`^\s*${COORD},\s*${COORD}\s*$`),
];

// Degrees, minutes and seconds: 17°03'24.3"N 79°16'05.4"E.
//
// This is what Google Maps puts on screen when you drop a pin and read
// the coordinates off it, so it is what a business that has been keeping
// its own list actually holds — the first real customer list onboarded
// here had thirty-two of them and two of anything else. Rejecting the
// format Maps shows, in favour of the decimals it hides, is the app
// asking people to convert by hand.
//
// Tolerant about the marks, because they survive a copy-paste badly:
// ° may be missing, ' may arrive as ′ or ’, " as ″ or ” or two
// apostrophes. Strict about the shape, so a house number never parses.
const DEGREE = String.raw`[°º]?`;
const MINUTE = String.raw`['′’]?`;
const SECOND = String.raw`(?:["″”]|'')?`;
const DMS_PART = String.raw`(\d{1,3})\s*${DEGREE}\s*(?:(\d{1,2})\s*${MINUTE}\s*(?:([\d.]+)\s*${SECOND})?)?`;
const DMS = new RegExp(
  String.raw`^\s*${DMS_PART}\s*([NS])\s*[, ]\s*${DMS_PART}\s*([EW])\s*$`,
  'i',
);

function parseDms(text) {
  const match = String(text).match(DMS);
  if (!match) {
    return null;
  }
  const value = (deg, min, sec) => Number(deg) + Number(min || 0) / 60 + Number(sec || 0) / 3600;
  const lat = value(match[1], match[2], match[3]) * (match[4].toUpperCase() === 'S' ? -1 : 1);
  const lng = value(match[5], match[6], match[7]) * (match[8].toUpperCase() === 'W' ? -1 : 1);
  // Minutes and seconds above 60 mean this was never DMS — most likely a
  // decimal pair that lost its point somewhere.
  if (Number(match[2] || 0) >= 60 || Number(match[3] || 0) >= 60) {
    return null;
  }
  if (Number(match[6] || 0) >= 60 || Number(match[7] || 0) >= 60) {
    return null;
  }
  return { lat, lng };
}

// Shortened links resolve only by following a redirect, and a browser
// cannot follow one to another origin and read where it went — the
// request is opaque to the page. So these can't be handled client-side,
// and pretending otherwise would mean failing with a confusing error
// instead of a clear instruction.
const SHORT_LINK_HOSTS = ['maps.app.goo.gl', 'goo.gl', 'g.co', 'bit.ly', 'maps.apple.com/?address'];

export function isShortMapLink(text) {
  const value = String(text || '').toLowerCase();
  return SHORT_LINK_HOSTS.some((host) => value.includes(host));
}

// parseMapLink returns {lat, lng} or null. Rejects anything outside the
// real coordinate range, which is what catches a pattern matching some
// unrelated number pair in a URL.
// `reference` is roughly where we already are — the pin being moved, or
// the business's own location. Only short plus codes need it, and only
// they are refused without it.
export function parseMapLink(text, reference = null) {
  const value = String(text || '').trim();
  if (!value) {
    return null;
  }

  const dms = parseDms(value);
  if (dms && inRange(dms)) {
    return dms;
  }

  if (looksLikePlusCode(value)) {
    const plus = decodePlusCode(value, reference);
    return plus && inRange(plus) ? plus : null;
  }

  for (const pattern of PATTERNS) {
    const match = value.match(pattern);
    if (!match) {
      continue;
    }
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      continue;
    }
    // 0,0 is the Gulf of Guinea and is never what someone meant to
    // share — the rest of this app treats it as "unset" too.
    if (lat === 0 && lng === 0) {
      continue;
    }
    return { lat, lng };
  }
  return null;
}

// The checks every parsed pair has to pass, wherever it came from.
function inRange({ lat, lng }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return false;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return false;
  }
  // 0,0 is the Gulf of Guinea and is never what someone meant to share —
  // the rest of this app treats it as "unset" too.
  return lat !== 0 || lng !== 0;
}

// What to tell someone whose paste didn't work. Short links get their own
// message because "that isn't a map link" would be wrong and unhelpful —
// it is a map link, it just can't be opened from here.
export function mapLinkError(text) {
  if (isShortMapLink(text)) {
    return 'Short map links can’t be read directly. Open it in Maps first, then copy the full link from the address bar — or just drop the pin below.';
  }
  // A short plus code that got this far had nowhere to be measured from.
  // Saying "that isn't a map link" would be wrong — it is one, we just
  // don't know which town it is in yet.
  if (looksLikePlusCode(text)) {
    return 'That plus code is the short kind, which only means something near a known place. Set your farm’s location on the Business tab first, or paste the full code (it starts with a few more letters).';
  }
  return 'That doesn’t look like a map link. Paste a Google or Apple link, a plus code, or coordinates — decimal or 17°03′24″N 79°16′05″E.';
}
