/**
 * The AVIF encoder, kept behind its own module so it lands in its own chunk.
 *
 * This is by far the largest codec here: 3.4 MB of wasm, about 4.5 MB once
 * base64-inlined, against 989 KB for MozJPEG, libwebp and OxiPNG combined. The
 * worker reaches it through a dynamic `import()`, so the chunk is fetched only by
 * someone who actually picks AVIF, and the PWA precache skips it: an install
 * should not pay several megabytes for a format most people never choose.
 *
 * The trade is that the first AVIF encode of a session downloads that chunk, so
 * offline AVIF only works after it has been used online once. Every other format
 * is fully offline from install.
 */
import avifWasm from '@jsquash/avif/codec/enc/avif_enc.wasm?bytes';
import encode, { init } from '@jsquash/avif/encode';
import { threads } from 'wasm-feature-detect';

let ready: Promise<unknown> | undefined;

/**
 * Encode raw pixels to AVIF.
 *
 * `speed` is libaom's effort dial inverted: 0 is slowest and smallest, 10 is
 * fastest and largest. jSquash defaults to 6, which is the usable middle; below
 * about 4 a full-size photo takes long enough that people assume the tab has
 * hung.
 */
export async function encodeAvif(pixels: ImageData, quality: number): Promise<ArrayBuffer> {
  ready ??= (async () => {
    // Only the single-threaded binary is inlined. jSquash picks the multithreaded
    // one when it detects wasm threads, which needs SharedArrayBuffer and so
    // cross-origin isolation; this site sets COOP without COEP, so that branch is
    // unreachable. Checked rather than assumed, because if COEP is ever added the
    // encoder would be handed a module built for the other target and fail
    // somewhere far less legible than here.
    if (await threads()) {
      throw new Error(
        'this build inlines the single-threaded AVIF encoder, but wasm threads are ' +
          'available: inline avif_enc_mt.wasm instead, or drop cross-origin isolation'
      );
    }
    await init(await WebAssembly.compile(avifWasm()));
  })();
  await ready;

  return encode(pixels, { quality });
}
