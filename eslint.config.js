// @ts-check
import js from '@eslint/js';
import astro from 'eslint-plugin-astro';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import svelteParser from 'svelte-eslint-parser';
import tseslint from 'typescript-eslint';

/**
 * Inlined rather than imported from a shared package: a fork should get the
 * exact rules this project is audited under from a clean checkout, with no
 * external dependency to resolve or trust first.
 */

// The CSP blocks egress at runtime. This blocks it at authoring time, so the
// guarantee is a rule you can read in the config rather than one you discover
// when the browser refuses the request.
const NO_NETWORK =
  'blakstrip makes no network calls: a file never leaves the device. See connect-src none in astro.config.mjs.';

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

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...astro.configs.recommended,
  // Static a11y for .astro pages, which had none. eslint-plugin-svelte v3
  // ships no a11y rules at all: Svelte's compiler emits them itself (a11y_*
  // warnings at build time), so the islands are covered there rather than here.
  // @axe-core/playwright covers runtime on top of both.
  ...astro.configs['flat/jsx-a11y-recommended'],
  ...svelte.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],

      // The no-egress guarantee, enforced where it is written rather than only
      // where it runs. Exemptions below are narrow and each has a reason.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: NO_NETWORK },
        { name: 'XMLHttpRequest', message: NO_NETWORK },
        { name: 'WebSocket', message: NO_NETWORK },
        { name: 'EventSource', message: NO_NETWORK },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'navigator', property: 'sendBeacon', message: NO_NETWORK },
      ],
    },
  },

  // Type-aware rules are off for .astro on purpose. astro-eslint-parser does
  // not support projectService (it warns and downgrades), and it cannot resolve
  // JSX types in the template, so every `.map()` returning markup reads as an
  // unsafe return. `astro check` type-checks these files properly; running both
  // buys nothing but false positives.
  {
    files: ['**/*.astro'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false } },
    rules: {
      // TypeScript and `astro check` already flag genuine undefined references;
      // no-undef only false-positives on ambient types like ImageMetadata here
      'no-undef': 'off',
    },
  },

  // Escaped JSON-LD injected via `set:html` by design. Listed file by file
  // rather than disabled globally: a new `set:html` anywhere else is a genuine
  // finding and should have to be added here first.
  {
    files: ['src/pages/index.astro', 'src/pages/pdf-redact.astro'],
    rules: { 'astro/no-set-html-directive': 'off' },
  },

  // Keep the two engines' bundles apart. download.ts is already split out so
  // pdf-lib does not reach chunks that do not need it; the same hazard is far
  // larger across engines, where one stray import drags the ~1.3 MB pdf.js
  // worker into a media island. Shared code belongs in src/lib/*.
  // In place before src/lib/media exists, so the guard predates the code.
  {
    files: ['src/lib/media/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/lib/pdf/**', '**/pdf/*'] }],
    },
  },
  {
    files: ['src/lib/pdf/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/lib/media/**', '**/media/*'] }],
    },
  },

  // Parse Svelte components with svelte-eslint-parser and their
  // `<script lang="ts">` blocks with the TypeScript parser. `.svelte.ts` /
  // `.svelte.js` runes modules go through the same parser.
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.svelte'],
      },
      globals: globals.browser,
    },
    rules: {
      // Return types on Svelte event handlers/reactive fns are noise, not safety.
      '@typescript-eslint/explicit-function-return-type': 'off',
      // Typing a `.svelte` import needs svelte2tsx, which this program does not
      // run, so every component's props resolve to `any` and every callback
      // argument reads as unsafe. `astro check` types these correctly. The
      // promise rules below are the reason type-aware linting is on at all, and
      // they keep working here.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // Config files and Node build scripts.
  {
    files: ['*.config.{js,mjs,ts}', 'scripts/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  // Build scripts are CLI reporters; printing to stdout is their whole job.
  {
    files: ['scripts/**/*.{js,mjs}'],
    rules: { 'no-console': 'off' },
  },

  // Site source JS runs in the browser (e.g. pre-paint is:inline scripts
  // shipped verbatim via ?raw imports).
  {
    files: ['src/**/*.{js,mjs}'],
    languageOptions: { globals: globals.browser },
  },

  // Tests run in the browser (Vitest browser project) or Node (Playwright/CLI).
  // The network ban deliberately still applies: nothing here needs it today, and
  // a test that suddenly wants fetch should have to justify an exemption rather
  // than inherit one. Playwright observes requests through its own `page.route`
  // API, not the global, so proving no-egress does not need the ban lifted.
  {
    files: ['tests/**/*.ts', 'src/**/*.test.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },

  // Ambient declaration files use import() type annotations by design:
  // global augmentation blocks cannot use top-level type imports.
  {
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },

  // Plain JavaScript carries no TS annotations, and type-aware rules need a
  // program these files are not part of.
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
]);
