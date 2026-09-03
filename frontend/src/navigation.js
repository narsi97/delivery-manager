import { Linking, Platform } from 'react-native';

// Turn-by-turn navigation is deliberately not built here — the driver
// already has a map app they trust, with their own traffic data and their
// own voice. This app owns which stop is next and what happens at the
// door; the map app owns getting there. See internal/route's package
// comment for the same trade-off on the routing side.
export function navigationUrl(lat, lng, label) {
  const destination = `${lat},${lng}`;
  if (Platform.OS === 'ios') {
    // Apple Maps is guaranteed present on iOS; Google Maps may not be.
    const query = label ? `&q=${encodeURIComponent(label)}` : '';
    return `http://maps.apple.com/?daddr=${destination}${query}`;
  }
  // The universal Google Maps URL opens the installed app on Android and
  // falls back to the browser everywhere else.
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
}

export function openNavigation(lat, lng, label) {
  const url = navigationUrl(lat, lng, label);
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    // A new tab, so the driver doesn't lose their place in the stop list.
    window.open(url, '_blank', 'noopener');
    return;
  }
  Linking.openURL(url).catch(() => {});
}

// Reads the device's current position, used for "pin this customer where
// I'm standing" and "start the route from here". Resolves to null rather
// than throwing when unavailable or denied — every caller has a manual
// lat/lng fallback, so a refusal should degrade, not error.
export function currentPosition() {
  return new Promise((resolve) => {
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : null;
    if (!geo) {
      resolve(null);
      return;
    }
    geo.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

// Ringing the customer from the doorstep.
//
// The single most common thing that goes wrong on a round is not finding
// the door — a gate that looks like the neighbour's, a name that isn't on
// the house, nobody answering. The number is already on the stop; the
// driver just had no way to reach it without leaving the app and
// searching for it. Same division of labour as navigation: this app knows
// which stop is next, the phone knows how to make calls.
export function callUrl(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  return digits ? `tel:${digits}` : '';
}

export function openCall(phone) {
  const url = callUrl(phone);
  if (url) {
    Linking.openURL(url).catch(() => {});
  }
  return !!url;
}
