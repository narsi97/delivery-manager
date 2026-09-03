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
  // Unknown means production, not local.
  //
  // This used to fall back to 'local' for anything it didn't recognise,
  // and NODE_ENV is 'production' during an Expo export — which is not a
  // key here. So a build where EXPO_PUBLIC_APP_ENV failed to arrive
  // resolved to *local*, and the deployed app showed the local-dev
  // sign-in door. The endpoint behind it 404s in production, so nothing
  // was reachable, but the guess ran the wrong way: an environment we
  // cannot identify is the one to be strict about.
  const declared = process.env.EXPO_PUBLIC_APP_ENV || '';
  const nodeEnv = process.env.NODE_ENV || '';
  const environment = environments[declared]
    ? declared
    : nodeEnv === 'development'
      ? 'local'
      : 'prod';
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
