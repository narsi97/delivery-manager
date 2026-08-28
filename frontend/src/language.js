import { Platform } from 'react-native';

const STORAGE_KEY = 'delivery-manager.language';
const DEFAULT_LANGUAGE = 'en';

// Mirrors session.js exactly — web-localStorage only, same reasoning: on
// a native build there's simply no persistence yet, and a driver falling
// back to English rather than a silent crash is the honest behaviour.
const canPersist = Platform.OS === 'web' && typeof window !== 'undefined' && !!window.localStorage;

export function loadLanguage() {
  if (!canPersist) {
    return DEFAULT_LANGUAGE;
  }
  try {
    return window.localStorage.getItem(STORAGE_KEY) || DEFAULT_LANGUAGE;
  } catch (error) {
    return DEFAULT_LANGUAGE;
  }
}

export function saveLanguage(lang) {
  if (!canPersist) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch (error) {
    // Private-browsing quota errors are not worth failing a language
    // switch over — it just won't survive a reload this time.
  }
}
