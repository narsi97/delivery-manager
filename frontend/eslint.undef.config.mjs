// Hunting one bug class: an identifier used but never imported or
// declared. It blanked the Herd screen in production (round1) and
// would have blanked Manage account on a pin tap (SelectedEntityEditor),
// because such a reference is invisible until the branch touching it
// renders — a screen that works only while a business has no data.
//
// Run from frontend/:
//   npx eslint --no-config-lookup --config eslint.undef.config.mjs "src/**/*.js"
//
// Named so ESLint does not auto-discover it: this is a targeted sweep,
// not the project's style config.
// value references (round1(...)); it does NOT catch JSX element names, so
// the second rule walks the scope chain for <Component> too.
let packaged = {};
try { packaged = (await import('globals')).default; } catch {}
const browserish = {
  ...(packaged.browser || {}), ...(packaged.node || {}), ...(packaged.es2021 || {}),
  window: 'readonly', document: 'readonly', console: 'readonly', fetch: 'readonly',
  navigator: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly',
  FileReader: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly', DecompressionStream: 'readonly',
  atob: 'readonly', btoa: 'readonly', AbortController: 'readonly', FormData: 'readonly',
  Response: 'readonly', Request: 'readonly', Headers: 'readonly', Intl: 'readonly',
  performance: 'readonly', crypto: 'readonly', process: 'readonly', global: 'readonly',
  __DEV__: 'readonly', alert: 'readonly', confirm: 'readonly', Image: 'readonly',
  HTMLInputElement: 'readonly', HTMLSelectElement: 'readonly', HTMLTextAreaElement: 'readonly',
};

const jsx = {
  rules: {
    'no-undef-component': {
      meta: { type: 'problem' },
      create(context) {
        return {
          JSXOpeningElement(node) {
            let name = node.name;
            while (name.type === 'JSXMemberExpression') name = name.object;
            if (name.type !== 'JSXIdentifier') return;
            const id = name.name;
            // Lowercase names are DOM/host tags (<input>, <select>).
            if (!/^[A-Z]/.test(id)) return;
            let scope = context.sourceCode.getScope(node);
            while (scope) {
              if (scope.variables.some((v) => v.name === id)) return;
              scope = scope.upper;
            }
            context.report({ node: name, message: `'${id}' is not defined` });
          },
        };
      },
    },
  },
};

const noop = { meta: {}, create: () => ({}) };
const reactHooks = { rules: { 'exhaustive-deps': noop, 'rules-of-hooks': noop } };

export default [{
  files: ['**/*.js'],
  plugins: { jsx, 'react-hooks': reactHooks },
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
    globals: browserish,
  },
  rules: { 'no-undef': 'error', 'jsx/no-undef-component': 'error' },
}];
