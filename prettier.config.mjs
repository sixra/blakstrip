import base from '@sixra/devkit/prettier';

export default {
  ...base,
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
};
