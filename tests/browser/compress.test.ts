/**
 * The compression pipeline end to end, in a real browser.
 *
 * These are the tests that prove the inlining works at all. Everything about the
 * wasm plumbing is invisible to types and to Node: whether the codec got its
 * module or quietly fell back to fetching one only shows up when the encoder
 * either produces bytes or does not.
 */
import { describe, expect, it } from 'vitest';
import { detectFormat, inspectMedia, verifyMedia } from '../../src/lib/media';
import { optionsForPreset, type CompressOptions } from '../../src/lib/media/compress';
import { Compressor, SupersededError } from '../../src/lib/media/compressor';
import { decodeToPixels } from '../support/decode';
import { baseJpeg, makeJpeg } from '../support/testjpeg';
import { makePng } from '../support/testpng';

/**
 * Large enough that the encoded size is dominated by image data rather than by
 * headers. At 32x24 a JPEG is mostly markers, and "the output got smaller" would
 * be measuring the wrong thing.
 */
const WIDTH = 640;
const HEIGHT = 480;

/** A compressor that is always torn down, so a failing test cannot leak a worker. */
async function withCompressor<T>(use: (compressor: Compressor) => Promise<T>): Promise<T> {
  const compressor = new Compressor();
  try {
    return await use(compressor);
  } finally {
    compressor.dispose();
  }
}

function options(overrides: Partial<CompressOptions> = {}): CompressOptions {
  return { ...optionsForPreset('balanced', 'jpeg'), ...overrides };
}

describe('compressing through the worker', () => {
  it('encodes a JPEG with the inlined MozJPEG, with no network involved', async () => {
    const source = await baseJpeg(WIDTH, HEIGHT);

    const result = await withCompressor((compressor) =>
      compressor.compress(source, 'jpeg', options({ format: 'jpeg', quality: 40 }))
    );

    // The assertion that matters: real JPEG bytes came back. If `init` had been
    // handed the wrong shape the codec would have tried to fetch its wasm, and
    // under `connect-src 'none'` that fetch fails and nothing is produced.
    expect(detectFormat(result.bytes)).toBe('jpeg');
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.bytes.length).toBeLessThan(source.length);
    expect({ width: result.width, height: result.height }).toEqual({
      width: WIDTH,
      height: HEIGHT,
    });
  }, 30_000);

  it('encodes a WebP with the inlined libwebp', async () => {
    const source = await baseJpeg(WIDTH, HEIGHT);

    const result = await withCompressor((compressor) =>
      compressor.compress(source, 'jpeg', options({ format: 'webp', quality: 50 }))
    );

    expect(detectFormat(result.bytes)).toBe('webp');
    expect(result.bytes.length).toBeLessThan(source.length);
  }, 30_000);

  it('optimises a PNG with the inlined OxiPNG without touching a pixel', async () => {
    const source = await makePng();

    const result = await withCompressor((compressor) =>
      compressor.compress(source, 'png', options({ format: 'png', effort: 2 }))
    );

    expect(detectFormat(result.bytes)).toBe('png');
    // PNG is lossless in both directions here, so anything other than an exact
    // pixel match means the pipeline is altering images it promised not to.
    expect(await decodeToPixels(result.bytes, 'image/png')).toEqual(
      await decodeToPixels(source, 'image/png')
    );
  }, 30_000);

  it('produces a smaller file at a lower quality', async () => {
    const source = await baseJpeg(WIDTH, HEIGHT);

    const [low, high] = await withCompressor(async (compressor) => [
      await compressor.compress(source, 'jpeg', options({ format: 'jpeg', quality: 25 })),
      await compressor.compress(source, 'jpeg', options({ format: 'jpeg', quality: 90 })),
    ]);

    expect(low.bytes.length).toBeLessThan(high.bytes.length);
  }, 45_000);

  it('resizes to the dimension cap and reports the size it actually encoded', async () => {
    const source = await baseJpeg(WIDTH, HEIGHT);

    const result = await withCompressor((compressor) =>
      compressor.compress(source, 'jpeg', options({ format: 'jpeg', maxDimension: 320 }))
    );

    expect({ width: result.width, height: result.height }).toEqual({ width: 320, height: 240 });
    // Reported dimensions are worthless if the file disagrees with them.
    const pixels = await decodeToPixels(result.bytes, 'image/jpeg');
    expect(pixels.length).toBe(320 * 240 * 4);
  }, 30_000);

  it('never enlarges an image to reach the cap', async () => {
    const source = await baseJpeg(64, 48);

    const result = await withCompressor((compressor) =>
      compressor.compress(source, 'jpeg', options({ format: 'jpeg', maxDimension: 4096 }))
    );

    expect({ width: result.width, height: result.height }).toEqual({ width: 64, height: 48 });
  }, 30_000);

  it('accepts options that are a reactive proxy rather than a plain object', async () => {
    // How this broke in production while every unit test passed: the UI holds its
    // options in a Svelte `$state`, which is a Proxy, and `postMessage` clones
    // structurally and throws `DataCloneError` on one. The tests all handed over
    // plain objects, so nothing noticed until the page was driven end to end.
    const source = await baseJpeg(WIDTH, HEIGHT);
    const proxied = new Proxy(options({ format: 'jpeg', quality: 50 }), {});

    const result = await withCompressor((compressor) =>
      compressor.compress(source, 'jpeg', proxied)
    );

    expect(detectFormat(result.bytes)).toBe('jpeg');
  }, 30_000);

  it('converts a PNG to WebP', async () => {
    // Only the conversion is asserted. An earlier version of this claimed to
    // prove the decoder is given the *source* type rather than the target, which
    // it cannot: Chrome sniffs the blob's content and decodes correctly either
    // way, so the mutation that swaps them leaves this green.
    const source = await makePng();

    const result = await withCompressor((compressor) =>
      compressor.compress(source, 'png', options({ format: 'webp', quality: 70 }))
    );

    expect(detectFormat(result.bytes)).toBe('webp');
  }, 30_000);

  it('encodes AVIF, which is lazily loaded and cannot be read back', async () => {
    // AVIF is the one output format this app can write but not parse, so it is
    // deliberately absent from MediaFormat and reachable only through
    // OutputFormat. `detectFormat` returning undefined here is the point: it
    // proves the engine is not claiming to understand the file it just made.
    const source = await baseJpeg(320, 240);

    const result = await withCompressor((compressor) =>
      compressor.compress(source, 'jpeg', options({ format: 'avif', quality: 50 }))
    );

    expect(result.format).toBe('avif');
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(detectFormat(result.bytes)).toBeUndefined();
    // The ISOBMFF brand is the honest check available without a parser.
    expect(String.fromCharCode(...result.bytes.subarray(4, 12))).toContain('ftyp');
  }, 120_000);
});

describe('compression and metadata', () => {
  it('leaves nothing identifying in the output of a file full of it', async () => {
    const source = await makeJpeg({
      exif: { gps: { lat: 51.5, lon: -0.12 }, make: 'ACME', model: 'X1', software: 'Cam 2.0' },
      xmp: true,
      iptc: true,
      comment: 'private note',
    });
    // The fixture is only meaningful if it really is carrying things.
    expect(inspectMedia(source).findings.length).toBeGreaterThan(0);

    const result = await withCompressor((compressor) =>
      compressor.compress(source, 'jpeg', options({ format: 'jpeg', quality: 60 }))
    );

    expect(verifyMedia(result.bytes)).toEqual({ clean: true, remaining: [] });
  }, 30_000);

  it('bakes rotation into the pixels rather than dropping it', async () => {
    // Orientation 6 means "stored rotated, turn it a quarter turn to display".
    // Re-encoding discards every tag, so if the rotation were not applied while
    // decoding, the output would be permanently sideways with nothing left to
    // correct it.
    //
    // The expectation is the literal upright size, not a second decode of the
    // same file: comparing two decodes moved both sides together and passed
    // whatever the pipeline did. This characterises the browser rather than our
    // option, because Chrome applies orientation here even when asked for
    // `imageOrientation: 'none'` (measured), so no mutation of that setting can
    // fail it. What it does catch is a future decoder handing back stored pixels.
    const source = await makeJpeg({ exif: { orientation: 6 } });

    const result = await withCompressor((compressor) =>
      compressor.compress(source, 'jpeg', options({ format: 'jpeg', quality: 80 }))
    );

    // The fixture is encoded 32 wide by 24 high, and tagged to display rotated.
    expect({ width: result.width, height: result.height }).toEqual({ width: 24, height: 32 });
  }, 30_000);
});

describe('superseding', () => {
  it('abandons a request that a newer one replaced', async () => {
    const source = await baseJpeg(WIDTH, HEIGHT);

    await withCompressor(async (compressor) => {
      const first = compressor.compress(source, 'jpeg', options({ quality: 30 }));
      const second = compressor.compress(source, 'jpeg', options({ quality: 80 }));

      await expect(first).rejects.toBeInstanceOf(SupersededError);
      await expect(second).resolves.toBeDefined();
    });
  }, 45_000);

  it('rejects anything outstanding when the worker is thrown away', async () => {
    const source = await baseJpeg(WIDTH, HEIGHT);
    const compressor = new Compressor();

    const pending = compressor.compress(source, 'jpeg', options());
    compressor.dispose();

    // Without this the promise never settles and the caller waits forever on a
    // worker that no longer exists.
    await expect(pending).rejects.toBeInstanceOf(SupersededError);
  }, 30_000);
});

describe('failure', () => {
  it('reports a readable error instead of hanging when the bytes are not an image', async () => {
    const notAnImage = new TextEncoder().encode('this is not a picture');

    await withCompressor(async (compressor) => {
      await expect(compressor.compress(notAnImage, 'jpeg', options())).rejects.toThrow();
    });
  }, 30_000);
});
