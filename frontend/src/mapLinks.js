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
export function parseMapLink(text) {
  const value = String(text || '').trim();
  if (!value) {
    return null;
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

// What to tell someone whose paste didn't work. Short links get their own
// message because "that isn't a map link" would be wrong and unhelpful —
// it is a map link, it just can't be opened from here.
export function mapLinkError(text) {
  if (isShortMapLink(text)) {
    return 'Short map links can’t be read directly. Open it in Maps first, then copy the full link from the address bar — or just drop the pin below.';
  }
  return 'That doesn’t look like a map link. Paste a Google, Apple or OpenStreetMap link, or drop the pin below.';
}
