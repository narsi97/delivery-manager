import { Platform } from 'react-native';

const STORAGE_KEY = 'delivery-manager.session';

// Session persistence is web-localStorage only. This app ships as a web
// build served behind Caddy (the driver adds it to their home screen);
// on a native build there is simply no persistence yet and the user signs
// in again, which is the honest behaviour rather than a silent no-op that
// looks like data loss.
const canPersist = Platform.OS === 'web' && typeof window !== 'undefined' && !!window.localStorage;

export function loadSession() {
  if (!canPersist) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    // A corrupt or unreadable entry must never wedge the app on a blank
    // screen — drop it and show the sign-in form.
    return null;
  }
}

export function saveSession(session) {
  if (!canPersist) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch (error) {
    // Private-browsing quota errors are not worth failing a sign-in over.
  }
}

export function clearSession() {
  if (!canPersist) {
    return;
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    // Nothing useful to do — the in-memory session is cleared regardless.
  }
}
