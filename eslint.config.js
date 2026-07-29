import base from '@sixra/devkit/eslint';
import svelte from '@sixra/devkit/eslint-svelte';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  globalIgnores([
    'dist/**',
    '.astro/**',
    'coverage/**',
    'test-results/**',
    'playwright-report/**',
    'dev-dist/**',
    'public/**',
  ]),

  ...base,
  ...svelte,

  // Node build/fixture scripts legitimately log progress to the console.
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },

  // Tests run in browser (Vitest browser project) or Node (Playwright/CLI).
  {
    files: ['tests/**/*.ts', 'src/**/*.test.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
]);
