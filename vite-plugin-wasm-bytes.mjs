/**
 * Inline a `.wasm` binary into the JS bundle as base64, imported as `foo.wasm?bytes`.
 *
 * The codecs must never fetch their own wasm. jSquash's default path does exactly
 * that, and a fetch is governed by `connect-src`, which this app pins to `'none'`
 * on the page and on `/_astro/*` (where the worker lives). Relaxing that to load a
 * compression codec would trade the one guarantee the product is built on for a
 * feature, so the bytes ship inside the chunk instead and `init()` is handed them
 * directly.
 *
 * Vite's own asset handling cannot do this: `?url` yields a URL and a large
 * `assetsInlineLimit` yields a `data:` URL, and the glue would still fetch either
 * one. A `data:` fetch is subject to `connect-src` too, so it fails the same way.
 *
 * Vendored rather than installed, for the same reason `size-budget.mjs` is: the
 * no-egress claim should be checkable by reading this repo alone.
 */
import { readFile } from 'node:fs/promises';

const SUFFIX = '?bytes';

/**
 * `new URL("something.wasm", import.meta.url)` inside a codec's Emscripten glue.
 * Vite treats this as an asset reference and emits the binary into the build, so
 * every inlined codec would otherwise ship a second time as a file nothing ever
 * requests, and the service worker would dutifully precache all of it.
 */
const GLUE_WASM_URL = /new URL\(\s*(['"])[^'"]+\.wasm\1\s*,\s*import\.meta\.url\s*\)/g;

/**
 * What that reference is rewritten to.
 *
 * A `data:` URL with no second argument, so Vite stops recognising it as an
 * asset. Reaching it at runtime means the inlining silently stopped working and
 * the glue fell back to fetching, and this fails loudly when that happens: the
 * fetch is blocked by `connect-src` in production and in dev alike, rather than
 * quietly succeeding in dev and breaking only once deployed.
 */
const INLINED_MARKER = 'new URL("data:,blakstrip-wasm-should-have-been-inlined")';

/** @returns {import('vite').Plugin} */
export default function wasmBytes() {
  return {
    name: 'wasm-bytes',
    // Ahead of Vite's asset plugin, which would otherwise claim the .wasm first.
    enforce: 'pre',

    async resolveId(source, importer) {
      if (!source.endsWith(`.wasm${SUFFIX}`)) return null;
      const resolved = await this.resolve(source.slice(0, -SUFFIX.length), importer, {
        skipSelf: true,
      });
      return resolved ? `${resolved.id}${SUFFIX}` : null;
    },

    async load(id) {
      if (!id.endsWith(`.wasm${SUFFIX}`)) return null;
      const file = id.slice(0, -SUFFIX.length);
      this.addWatchFile(file);
      const base64 = (await readFile(file)).toString('base64');

      // Decoded on call rather than at module scope, so importing the codec table
      // does not decode every codec a user never chooses. Nothing is memoized:
      // each codec is initialised once per worker, so a cache would only add an
      // aliasing hazard if `init` ever detached the buffer it was given.
      return `const BASE64 = ${JSON.stringify(base64)};

export default function wasmBytes() {
  const binary = atob(BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
`;
    },

    /**
     * Cut the codec glue's own path to its `.wasm` file.
     *
     * Emscripten only fetches when it was given no module, which is a mistake
     * this setup makes impossible. But Vite emits the asset regardless of whether
     * the branch can run, so without this every codec ships twice: once inlined
     * and used, once as a file that is precached and never requested.
     */
    transform(code, id) {
      if (!id.includes('@jsquash') || !GLUE_WASM_URL.test(code)) return null;
      GLUE_WASM_URL.lastIndex = 0;
      return { code: code.replace(GLUE_WASM_URL, INLINED_MARKER), map: null };
    },
  };
}
