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
  overrides: [...(base.overrides ?? []), { files: '*.svelte', options: { parser: 'svelte' } }],
  importOrder: [
    '^(astro/(.*)$)|^(astro$)',
    '^@astrojs/',
    '<THIRD_PARTY_MODULES>',
    '^@/(.*)$',
    '^@components/(.*)$',
    '^@layouts/(.*)$',
    '^@lib/(.*)$',
    '^@styles/(.*)$',
    '^[./]',
  ],
  importOrderParserPlugins: ['typescript'],
};
