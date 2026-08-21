const environments = {
  local: {
    apiBaseUrl: 'http://localhost:8087',
  },
  dev: {
    apiBaseUrl: 'http://localhost:8087',
  },
  prod: {
    // Always overridden by EXPO_PUBLIC_API_URL at build time — this is
    // just the fallback if that's somehow unset.
    apiBaseUrl: 'https://3vnsystems.com/delivery-manager',
  },
};

// IMPORTANT: Expo's EXPO_PUBLIC_* build-time inlining only works for STATIC
// `process.env.EXPO_PUBLIC_X` references — see the Interest Optimizer
// project-conventions notes for the real production bug this caused there.
// Every EXPO_PUBLIC_* var below is its own static expression, not a helper
// function taking the name as a parameter.
export function getFrontendConfig() {
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV || process.env.NODE_ENV || 'local';
  const environment = environments[appEnv] ? appEnv : 'local';
  const defaults = environments[environment];

  return {
    environment,
    apiBaseUrl: process.env.EXPO_PUBLIC_API_URL || defaults.apiBaseUrl,
    // Google Cloud Console OAuth 2.0 Web client ID. Admins sign in with
    // Google; drivers never need it (phone + PIN). The "Sign in with
    // Google" button only renders when this is present.
    googleClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '',
  };
}

export { environments };
