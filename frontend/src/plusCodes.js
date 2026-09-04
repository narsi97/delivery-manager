// Plus codes (Open Location Code).
//
// Google Maps offers one for every point on earth and calls it the
// place's address, which for a farm on an unnamed road outside a town is
// often the only precise address that exists. The first real business
// onboarded onto this app gave its own location as "X429+VC, Ramachandra
// Puram" — no street, no number, because there isn't one.
//
// Two forms arrive:
//   7J8XX429+VC   full, decodes on its own
//   X429+VC       short, and only means something near somewhere else
//
// The short form is what Maps shows and what people copy, so it has to
// work — and it can, because this app always knows roughly where it is:
// the pin being moved, or the business's own farm.
//
// Ten characters is where this stops. The eleventh and beyond switch to
// a different grid for the last few metres, and ten already lands inside
// a 14-metre square — smaller than the gate the driver is looking for.

const ALPHABET = '23456789CFGHJMPQRVWX';
const SEPARATOR = '+';
const SEPARATOR_POSITION = 8;
const PADDING = '0';
const PAIR_PRECISION = 10;

// A code is a plus code if it has the separator in the right place and
// says nothing else. Deliberately strict: this runs against every paste,
// and matching loosely would claim strings meant for another parser.
const CODE = /^([23456789CFGHJMPQRVWX]{2,8}|[23456789CFGHJMPQRVWX]{2,8}0*)\+([23456789CFGHJMPQRVWX]{0,7})$/i;

export function looksLikePlusCode(text) {
  return CODE.test(String(text || '').trim());
}

// Decodes a full code to the centre of the square it names.
function decodeFull(code) {
  const digits = code.replace(/\+/g, '').replace(new RegExp(`${PADDING}+$`), '').toUpperCase();
  let lat = -90;
  let lng = -180;
  let resolution = 20;
  for (let i = 0; i + 1 < digits.length && i < PAIR_PRECISION; i += 2) {
    lat += ALPHABET.indexOf(digits[i]) * resolution;
    lng += ALPHABET.indexOf(digits[i + 1]) * resolution;
    resolution /= 20;
  }
  // The centre, not the corner: a corner would put the pin on the edge
  // of the square and could land it across the road.
  const size = resolution * 20;
  return { lat: lat + size / 2, lng: lng + size / 2 };
}

function encodeFull(lat, lng) {
  let remainingLat = Math.min(Math.max(lat, -90), 90) + 90;
  let remainingLng = (((lng + 180) % 360) + 360) % 360;
  let resolution = 20;
  let out = '';
  for (let i = 0; i < PAIR_PRECISION / 2; i += 1) {
    const latDigit = Math.floor(remainingLat / resolution);
    const lngDigit = Math.floor(remainingLng / resolution);
    out += ALPHABET[Math.min(latDigit, 19)] + ALPHABET[Math.min(lngDigit, 19)];
    remainingLat -= latDigit * resolution;
    remainingLng -= lngDigit * resolution;
    resolution /= 20;
  }
  return out;
}

// A short code plus somewhere to stand. Returns the nearest square with
// that ending — which is what Maps means when it shows you one.
export function decodePlusCode(text, reference = null) {
  const code = String(text || '').trim().toUpperCase();
  if (!CODE.test(code)) {
    return null;
  }
  const separator = code.indexOf(SEPARATOR);
  if (separator === SEPARATOR_POSITION) {
    return decodeFull(code);
  }
  // Short: the missing leading characters come from the reference. With
  // nowhere to stand there is no answer, and guessing one would put a
  // customer in another state.
  if (!reference || !Number.isFinite(reference.lat) || !Number.isFinite(reference.lng)) {
    return null;
  }
  const padding = SEPARATOR_POSITION - separator;
  if (padding <= 0 || padding % 2 !== 0) {
    return null;
  }
  const resolution = 20 ** (2 - padding / 2);
  const prefix = encodeFull(reference.lat, reference.lng).slice(0, padding);
  const decoded = decodeFull(prefix + code);

  // The recovered square may be the wrong side of a grid line from the
  // reference; nudge it to whichever of the two is actually nearer.
  let { lat, lng } = decoded;
  const half = resolution / 2;
  if (reference.lat + half < lat && lat - resolution >= -90) {
    lat -= resolution;
  } else if (reference.lat - half > lat && lat + resolution <= 90) {
    lat += resolution;
  }
  if (reference.lng + half < lng) {
    lng -= resolution;
  } else if (reference.lng - half > lng) {
    lng += resolution;
  }
  return { lat, lng };
}
