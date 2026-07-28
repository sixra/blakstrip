import base from '@sixra/devkit/eslint';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import svelteParser from 'svelte-eslint-parser';
import tseslint from 'typescript-eslint';

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

  // Svelte 5 components: parse the file with svelte-eslint-parser and its
  // `<script lang="ts">` blocks with the TypeScript parser.
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.svelte'],
      },
      globals: globals.browser,
    },
    // Return types on Svelte event handlers/reactive fns are noise, not safety.
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
  },

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
