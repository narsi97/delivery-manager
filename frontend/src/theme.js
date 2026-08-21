// One palette, deliberately. The other 3VNSYSTEMS frontends ship a
// light/dark toggle; this app's primary surface is a driver's phone held
// outdoors at dawn, where high contrast matters far more than theming, so
// there is a single high-contrast scheme and no toggle to get wrong.
export const colors = {
  background: '#f7f8fa',
  surface: '#ffffff',
  surfaceAlt: '#eef2f7',
  border: '#d8dee8',
  text: '#0f172a',
  subtitle: '#5b6779',
  label: '#334155',
  hint: '#8493a8',
  accent: '#0f766e',
  accentText: '#ffffff',
  link: '#0e7490',
  success: '#15803d',
  successBg: '#dcfce7',
  warning: '#b45309',
  warningBg: '#fef3c7',
  error: '#b91c1c',
  errorBg: '#fee2e2',
  muted: '#e2e8f0',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

export const radius = { sm: 6, md: 10, lg: 14 };
