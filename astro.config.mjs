// @ts-check
import process from 'node:process';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import AstroPWA from '@vite-pwa/astro';
import inlineBytes from './vite-plugin-inline-bytes.mjs';

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
        // No 'wasm-unsafe-eval', deliberately. Compiling wasm on the *page* is
        // blocked by this policy (measured: WebAssembly.compile throws), but the
        // codecs only ever run in a worker, and a worker loaded from a same-origin
        // URL does not inherit the document policy (measured: the same compile is
        // allowed there). Adding the directive would relax the page for nothing.
        // The trap is blob: workers, which do inherit: the codec worker has to stay
        // a real emitted file, never `?worker&inline`.
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
      // The home entry is emitted without a trailing slash while its canonical
      // has one. Not worth chasing: an empty path and "/" are the same URL per
      // RFC 3986 §6.2.3, and the integration's trailingSlash handling rewrites
      // this after serialize runs, so setting item.url here would be dead code.
      serialize(item) {
        const isHome =
          item.url === 'https://blakstrip.com' || item.url === 'https://blakstrip.com/';
        item.priority = isHome ? 1.0 : 0.8;
        return item;
      },
    }),
    AstroPWA({
      registerType: 'autoUpdate',
      // We register the SW from a bundled <script> in Base.astro so Astro hashes it
      // under the strict CSP (an injected inline script would be blocked).
      injectRegister: false,
      manifest: {
        name: 'blakstrip · private file tools',
        short_name: 'blakstrip',
        description:
          'Redact PDFs and strip photo metadata entirely in your browser. Nothing is uploaded.',
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
    plugins: [tailwindcss(), inlineBytes()],
    // jSquash's own README calls for this: pre-bundling rewrites the codec glue's
    // wasm resolution and it fails at runtime with "Invalid URL".
    optimizeDeps: {
      exclude: ['@jsquash/jpeg', '@jsquash/webp', '@jsquash/oxipng'],
    },
    worker: {
      // ES, not the 'iife' default, to match the `type: 'module'` the Worker is
      // constructed with. Measured: iife builds and runs here too, because
      // rolldown folds the codec glue's dynamic imports (webp's SIMD variant,
      // oxipng's threaded one) into the single bundle. That is incidental, and
      // depending on it would mean a worker declared one way and emitted another.
      format: 'es',
      // `plugins` above applies to workers in dev only; a build gives each worker
      // its own rolldown pass, which needs its own instances. Without this the
      // wasm imports resolve to nothing and the build fails with
      // UNLOADABLE_DEPENDENCY, which is at least loud.
      plugins: () => [inlineBytes()],
    },
  },
});
