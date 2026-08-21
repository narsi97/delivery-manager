// Dynamic Expo config. Wraps app.json so the static config stays the source
// of truth for everything except the web "base path" used when this app is
// served under a subpath (e.g. https://3vnsystems.com/delivery-manager/)
// behind a reverse proxy, instead of at the domain root. Same pattern as
// the other 3VNSYSTEMS frontends.
module.exports = ({ config }) => {
  const basePath = process.env.EXPO_WEB_BASE_PATH;
  if (!basePath) {
    return config;
  }

  return {
    ...config,
    experiments: {
      ...(config.experiments || {}),
      baseUrl: basePath,
    },
  };
};
