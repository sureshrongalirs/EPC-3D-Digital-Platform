// @ts-check
import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'deploy/data/**',
      'testdata/local/**',
      // Vendored third-party assets (e.g. three.js's DRACO decoder, copied verbatim per
      // CLAUDE.md's no-CDN-at-runtime invariant) — not our source, never linted.
      '**/public/draco/**',
      // Cesium's static asset tree, copied from node_modules at dev/build time (see
      // apps/demo/scripts/copy-cesium-assets.mjs) — not our source, never linted.
      '**/public/cesium/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    // Plain Node scripts (asset-copying, fixture generation) run outside any browser
    // context, so they need Node's globals rather than (or in addition to) the DOM ones
    // packages/apps otherwise use.
    files: ['**/scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
);
