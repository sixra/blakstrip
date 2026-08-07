/**
 * Inlined rather than imported from a shared package: a fork should be able to
 * check out this repo and get identical formatting with no external config.
 */
export default {
  singleQuote: true,
  semi: true,
  printWidth: 100,
  tabWidth: 2,
  trailingComma: 'es5',
  // prettier-plugin-tailwindcss must stay last: it composes with the others.
  plugins: [
    '@ianvs/prettier-plugin-sort-imports',
    'prettier-plugin-astro',
    'prettier-plugin-svelte',
    'prettier-plugin-tailwindcss',
  ],
  importOrder: [
    '^(astro/(.*)$)|^(astro$)',
    '^@astrojs/',
    '<THIRD_PARTY_MODULES>',
    '^@lib/(.*)$',
    '^[./]',
  ],
  importOrderParserPlugins: ['typescript'],
  overrides: [
    {
      files: '*.astro',
      options: { parser: 'astro' },
    },
    {
      files: '*.svelte',
      options: { parser: 'svelte' },
    },
  ],
};
