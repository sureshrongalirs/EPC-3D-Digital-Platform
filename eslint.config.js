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
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
);
