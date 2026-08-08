/**
 * The compression worker: decode, resize, re-encode. One job at a time.
 *
 * It runs off the main thread because a wasm encode of a full-size photo blocks
 * for long enough to freeze the page, and because tearing the worker down is the
 * only reliable way to give wasm memory back: a linear memory never shrinks once
 * it has grown, so a long session of large files would otherwise ratchet upwards
 * for as long as the tab is open.
 *
 * It also has to run here for a second reason that is easy to lose. This app's
 * page CSP has no `'wasm-unsafe-eval'`, so `WebAssembly.compile` throws on the
 * main thread (measured). A worker loaded from a same-origin URL does not inherit
 * the document policy, so the same call succeeds here. That is a load-bearing
 * fact, not an optimisation: see the note in `astro.config.mjs`.
 *
 * Only *encoding* uses wasm. Decoding and resizing are native browser work via
 * `createImageBitmap` and `OffscreenCanvas`, which halves what has to ship and is
 * faster than the wasm decoders besides.
 */
import mozjpegWasm from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?bytes';
import encodeJpeg, { init as initJpeg } from '@jsquash/jpeg/encode';
import oxipngWasm from '@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm?bytes';
import optimisePng, { init as initOxipng } from '@jsquash/oxipng/optimise';
import webpWasm from '@jsquash/webp/codec/enc/webp_enc_simd.wasm?bytes';
import encodeWebp, { init as initWebp } from '@jsquash/webp/encode';
import { simd } from 'wasm-feature-detect';
import { fitWithin, type CompressRequest, type CompressResponse } from './compress';
import { mimeTypeFor, type MediaFormat } from './index';

/**
 * jSquash's `init` takes a compiled `WebAssembly.Module`, not the bytes.
 *
 * This distinction is worth the function it is written in. `init(someArrayBuffer)`
 * does not throw: the glue sees a single argument that is not a `WebAssembly.Module`
 * and re-reads it as an options object, leaving the module undefined, and
 * Emscripten then falls back to *fetching* the `.wasm` beside the script. In dev
 * that fetch succeeds and everything looks fine; in production `connect-src 'none'`
 * blocks it and compression breaks. Compiling here makes the wrong shape
 * impossible to pass.
 */
function compile(bytes: () => ArrayBuffer): Promise<WebAssembly.Module> {
  return WebAssembly.compile(bytes());
}

// Each codec is initialised at most once per worker, on first use, so opening a
// JPEG never pays for the PNG optimiser.
let jpegReady: Promise<unknown> | undefined;
let webpReady: Promise<unknown> | undefined;
let pngReady: Promise<unknown> | undefined;

function readyJpeg(): Promise<unknown> {
  return (jpegReady ??= compile(mozjpegWasm).then(initJpeg));
}

function readyWebp(): Promise<unknown> {
  return (webpReady ??= (async () => {
    // Only the SIMD build is shipped; carrying both would add another 276 KB for
    // browsers that have not existed for years. Checked rather than assumed,
    // because `init` would otherwise hand a SIMD module to the scalar factory and
    // fail somewhere far less legible than here.
    if (!(await simd())) {
      throw new Error('this browser is missing WebAssembly SIMD, which WebP compression needs');
    }
    return initWebp(await compile(webpWasm));
  })());
}

function readyPng(): Promise<unknown> {
  // `optimise()` calls `init()` with no argument when it has not run yet, which
  // would fetch. Getting in first is what makes the memo hold our module.
  //
  // jSquash picks a multithreaded oxipng build when it detects wasm threads in a
  // worker. That needs SharedArrayBuffer, which needs cross-origin isolation,
  // which this site does not set (COOP without COEP), so the single-threaded path
  // is the one that runs and the single-threaded binary is the one inlined here.
  // Adding COEP later would flip that branch and break this: keep them together.
  return (pngReady ??= compile(oxipngWasm).then(initOxipng));
}

/**
 * Bytes to pixels, using the browser's own decoders.
 *
 * `imageOrientation: 'from-image'` is set explicitly rather than left to the
 * default because it decides whether a phone photo comes out upright. The pixels
 * in such a file are stored rotated, with an EXIF tag saying how to turn them;
 * re-encoding drops all metadata, so the rotation has to be baked into the pixels
 * here or the output is silently sideways.
 *
 * `premultiplyAlpha: 'none'` keeps semi-transparent PNG pixels from losing
 * precision on the way through.
 */
async function decode(bytes: Uint8Array, format: MediaFormat): Promise<ImageBitmap> {
  const blob = new Blob([bytes as BlobPart], { type: mimeTypeFor(format) });
  return createImageBitmap(blob, {
    imageOrientation: 'from-image',
    premultiplyAlpha: 'none',
  });
}

/** Draw the bitmap at the target size and read the pixels back. */
function rasterize(bitmap: ImageBitmap, width: number, height: number): ImageData {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('this browser could not provide a 2D canvas to resize with');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

async function encode(pixels: ImageData, request: CompressRequest): Promise<ArrayBuffer> {
  const { format, quality, effort } = request.options;
  switch (format) {
    case 'jpeg':
      await readyJpeg();
      return encodeJpeg(pixels, { quality });
    case 'webp':
      await readyWebp();
      return encodeWebp(pixels, { quality });
    case 'png':
      // No quality: PNG is lossless, so `effort` buys the only reduction there
      // is. OxiPNG takes the raw pixels directly, which skips encoding a PNG
      // through the canvas first only to have it rewritten.
      await readyPng();
      return optimisePng(pixels, { level: effort, interlace: false, optimiseAlpha: true });
  }
}

async function run(request: CompressRequest): Promise<CompressResponse> {
  try {
    const source = await decode(request.bytes, request.sourceFormat);
    let pixels: ImageData;
    try {
      const size = fitWithin(
        { width: source.width, height: source.height },
        request.options.maxDimension
      );
      pixels = rasterize(source, size.width, size.height);
    } finally {
      // Frees the decoded frame now rather than at the next GC. On a 48 megapixel
      // photo that is nearly 200 MB held for no reason while the encoder runs.
      source.close();
    }

    const encoded = await encode(pixels, request);
    return {
      id: request.id,
      ok: true,
      bytes: new Uint8Array(encoded),
      format: request.options.format,
      width: pixels.width,
      height: pixels.height,
    };
  } catch (error) {
    // The message is ours or a codec's, never file contents, so it is safe to show.
    return {
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : 'the image could not be compressed',
    };
  }
}

// At most one job waiting. A newer request replaces the waiting one outright
// instead of joining a queue, so releasing a slider after ten intermediate values
// encodes twice (the one in flight and the last one) rather than eleven times.
let pending: CompressRequest | undefined;
let running = false;

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending) {
      const request = pending;
      pending = undefined;
      const response = await run(request);
      const transfer = response.ok ? [response.bytes.buffer] : [];
      self.postMessage(response, { transfer });
    }
  } finally {
    running = false;
  }
}

self.onmessage = (event: MessageEvent<CompressRequest>) => {
  pending = event.data;
  void pump();
};
