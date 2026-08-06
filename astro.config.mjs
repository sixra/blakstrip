// @ts-check
import process from 'node:process';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import AstroPWA from '@vite-pwa/astro';

// In production the CSP locks network egress to nothing; the dev branch below
// keeps a websocket open for Vite's HMR in case the policy is emitted there.
const isDev = process.argv.includes('dev');

// https://astro.build/config
export default defineConfig({
  site: 'https://blakstrip.com',
  trailingSlash: 'never',
  build: { format: 'file', inlineStylesheets: 'always' },
  // No prefetch: it would fetch() pages, which `connect-src 'none'` blocks.
  // The no-egress guarantee (verifiable in devtools) matters more than a hint.
  // No markdown yet, and Shiki's inline styles violate the strict CSP.
  markdown: { syntaxHighlight: false },

  // Provable privacy: no network egress. Astro auto-hashes bundled script/style;
  // these directives are merged into the generated <meta> CSP on every static page.
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        isDev ? "connect-src 'self' ws: wss:" : "connect-src 'none'",
        "worker-src 'self' blob:", // service worker + pdf.js worker
        "img-src 'self' data: blob:", // canvas raster + icons
        "font-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ],
    },
  },

  integrations: [
    svelte(),
    sitemap({
      // Home ranks highest; each tool page is a primary surface. No lastmod,
      // which avoids false freshness signals on rarely-changing static pages.
      serialize(item) {
        item.priority = item.url === 'https://blakstrip.com/' ? 1.0 : 0.8;
        return item;
      },
    }),
    AstroPWA({
      registerType: 'autoUpdate',
      // We register the SW from a bundled <script> in Base.astro so Astro hashes it
      // under the strict CSP (an injected inline script would be blocked).
      injectRegister: false,
      manifest: {
        name: 'blakstrip · private PDF redactor',
        short_name: 'blakstrip',
        description: 'Remove content from PDFs entirely, in your browser, nothing uploaded.',
        theme_color: '#f4f4f4',
        background_color: '#f4f4f4',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // pdf.js ships its worker as .mjs; without that extension the app installs
        // but cannot open a PDF offline, which is the whole point of installing it.
        globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,woff2,wasm}'],
        // The worker is ~1.3 MB and grows each release; workbox silently skips
        // anything over its 2 MiB default, so pin the ceiling rather than drift into it.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
