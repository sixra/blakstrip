import { describe, expect, it } from 'vitest';
import { MalformedFileError, u32le } from '../../src/lib/media/bytes';
import {
  classifyWebpChunk,
  inspectWebp,
  isWebp,
  parseWebpChunks,
  stripWebp,
} from '../../src/lib/media/webp';
import type { Finding } from '../../src/lib/types';
import { decodeToPixels } from '../support/decode';
import { makeWebp, vp8xFlags, webpChunk } from '../support/testwebp';

const FLAG_ICC = 0x20;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;

function findingIds(bytes: Uint8Array): string[] {
  return inspectWebp(bytes).map((f) => f.id);
}

function fourccs(bytes: Uint8Array): string[] {
  return parseWebpChunks(bytes).map((c) => c.fourcc);
}

describe('webp audit', () => {
  it('finds every planted leak vector', async () => {
    const bytes = await makeWebp({
      exif: { make: 'ACME', gps: { lat: 44.8125, lon: 20.4612 } },
      xmp: true,
      unknownChunk: true,
    });

    const ids = findingIds(bytes);
    expect(ids).toEqual(expect.arrayContaining(['exif-gps', 'exif-device', 'webp-xmp']));
    expect(ids.some((id) => id.startsWith('webp-chunk-vNDr'))).toBe(true);
  });

  it('reads GPS out of an EXIF chunk, which stores raw TIFF', async () => {
    const bytes = await makeWebp({ exif: { gps: { lat: 44.8125, lon: 20.4612 } } });
    const gps = inspectWebp(bytes).find((f) => f.id === 'exif-gps');
    expect(gps?.severity).toBe('high');
    const [lat, lon] = (gps?.detail ?? '').split(', ').map(Number);
    expect(lat).toBeCloseTo(44.8125, 3);
    expect(lon).toBeCloseTo(20.4612, 3);
  });

  it("reads GPS from an EXIF chunk that keeps JPEG's Exif\\0\\0 prefix", async () => {
    // Both shapes are in the wild and the parser has a branch for each, but only
    // the raw-TIFF one had ever run. If the prefixed path were wrong every offset
    // would be six bytes out, and the likely result is not an error: it is a photo
    // whose location is quietly not found, reported to the user as clean.
    const raw = await makeWebp({ exif: { gps: { lat: 51.5, lon: -0.12 } } });
    const prefixed = await makeWebp({
      exif: { gps: { lat: 51.5, lon: -0.12 } },
      exifPrefixed: true,
    });

    // The two files differ by six bytes, so this is not comparing a file to itself.
    expect(prefixed.length).toBe(raw.length + 6);

    const gpsFinding = (bytes: Uint8Array): Finding | undefined =>
      inspectWebp(bytes).find((f) => f.id === 'exif-gps');
    expect(gpsFinding(prefixed)).toBeDefined();
    expect(gpsFinding(prefixed)?.detail).toBe(gpsFinding(raw)?.detail);
  });

  it('reports unreadable EXIF instead of refusing to audit the file', async () => {
    const bytes = await makeWebp({ exif: { make: 'ACME' }, xmp: true });
    const exif = parseWebpChunks(bytes).find((c) => c.fourcc === 'EXIF');
    const copy = new Uint8Array(bytes);
    if (exif) copy[exif.dataAt] = 0x00;

    const ids = inspectWebp(copy).map((f) => f.id);
    expect(ids).toContain('webp-exif-unreadable');
    expect(ids).toContain('webp-xmp');
  });

  it('finds nothing in an image that carries nothing', async () => {
    expect(findingIds(await makeWebp())).toEqual([]);
  });
});

describe('webp strip', () => {
  it('removes every identifying chunk and verifies clean', async () => {
    const bytes = await makeWebp({
      exif: { make: 'ACME', gps: { lat: 44.8, lon: 20.4 } },
      xmp: true,
      unknownChunk: true,
    });
    expect(findingIds(bytes).length).toBeGreaterThan(0);

    const stripped = stripWebp(bytes).bytes;

    expect(inspectWebp(stripped)).toEqual([]);
    for (const gone of ['EXIF', 'XMP ', 'vNDr']) {
      expect(fourccs(stripped)).not.toContain(gone);
    }
  });

  it('rewrites the RIFF size field to match the shortened file', async () => {
    // A stale size is the one corruption this rebuild can introduce, and it
    // would surface only in some other decoder, long after the fact.
    const bytes = await makeWebp({ exif: { make: 'ACME' }, xmp: true, unknownChunk: true });
    const stripped = stripWebp(bytes).bytes;
    expect(u32le(stripped, 4)).toBe(stripped.length - 8);
    expect(stripped.length).toBeLessThan(bytes.length);
  });

  it('clears the VP8X flags for the chunks it removed', async () => {
    // Leaving a flag set for an absent chunk makes the file claim metadata that
    // is not there, and the spec tells readers to fail on exactly that.
    const bytes = await makeWebp({ exif: { make: 'ACME' }, xmp: true, icc: true });
    expect(vp8xFlags(bytes)).toBe(FLAG_ICC | FLAG_EXIF | FLAG_XMP);

    const flags = vp8xFlags(stripWebp(bytes).bytes);
    expect(flags).toBeDefined();
    expect((flags ?? 0) & FLAG_EXIF).toBe(0);
    expect((flags ?? 0) & FLAG_XMP).toBe(0);
    // ICC is kept by default, so its flag must stay set.
    expect((flags ?? 0) & FLAG_ICC).toBe(FLAG_ICC);
  });

  it('clears the ICC flag too when the profile is dropped on request', async () => {
    const bytes = await makeWebp({ icc: true, exif: { make: 'ACME' } });
    const flags = vp8xFlags(stripWebp(bytes, { keepColorProfile: false }).bytes);
    expect((flags ?? 0) & FLAG_ICC).toBe(0);
    expect(fourccs(stripWebp(bytes, { keepColorProfile: false }).bytes)).not.toContain('ICCP');
  });

  it('keeps the colour profile by default', async () => {
    const bytes = await makeWebp({ icc: true, exif: { make: 'ACME' } });
    expect(fourccs(stripWebp(bytes).bytes)).toContain('ICCP');
  });

  it('is lossless: the image bitstream chunk is byte-identical', async () => {
    const bytes = await makeWebp({ exif: { make: 'ACME' }, xmp: true });
    const stripped = stripWebp(bytes).bytes;

    const imageOf = (buf: Uint8Array): Uint8Array | undefined => {
      const chunk = parseWebpChunks(buf).find(
        (c) => c.fourcc === 'VP8 ' || c.fourcc === 'VP8L' || c.fourcc === 'ALPH'
      );
      return chunk ? buf.subarray(chunk.start, chunk.end) : undefined;
    };

    expect(imageOf(stripped)).toBeDefined();
    expect(imageOf(stripped)).toEqual(imageOf(bytes));
  });

  it('decodes to identical pixels after stripping', async () => {
    const bytes = await makeWebp({ exif: { make: 'ACME' }, xmp: true });
    expect(await decodeToPixels(stripWebp(bytes).bytes, 'image/webp')).toEqual(
      await decodeToPixels(bytes, 'image/webp')
    );
  });

  it('reports no notes: this format keeps nothing the user would not expect', async () => {
    // JPEG keeps an orientation tag and says so. Nothing here has an
    // equivalent, so an empty notes list is the contract, not an oversight.
    const bytes = await makeWebp();
    expect(stripWebp(bytes).notes).toEqual([]);
  });

  it('leaves an already-clean file structurally intact', async () => {
    const bytes = await makeWebp();
    expect(fourccs(stripWebp(bytes).bytes)).toEqual(fourccs(bytes));
  });
});

describe('webp chunk classification', () => {
  it('keeps animation chunks, which are image data and not metadata', () => {
    // The same trap APNG set: dropping these turns an animation into one frame.
    for (const type of ['ANIM', 'ANMF', 'ALPH']) {
      expect(classifyWebpChunk(type)).toBe('structural');
    }
  });

  it('handles the four-character codes that carry a trailing space', () => {
    // `VP8 ` and `XMP ` are four characters including the space. Trimming them
    // anywhere in the parse would misclassify both.
    expect(classifyWebpChunk('VP8 ')).toBe('structural');
    expect(classifyWebpChunk('XMP ')).toBe('xmp');
    expect(classifyWebpChunk('VP8')).toBe('unknown');
  });

  it('treats anything it does not know as unknown, so the allowlist drops it', () => {
    expect(classifyWebpChunk('vNDr')).toBe('unknown');
  });
});

describe('webp parser hostility', () => {
  it('rejects a file that is not a WebP', () => {
    expect(isWebp(new Uint8Array([1, 2, 3, 4]))).toBe(false);
    expect(() => parseWebpChunks(new Uint8Array([1, 2, 3, 4]))).toThrow(MalformedFileError);
  });

  it('rejects RIFF that is not WEBP', () => {
    const bytes = new Uint8Array(12);
    for (let i = 0; i < 4; i += 1) bytes[i] = 'RIFF'.charCodeAt(i);
    for (let i = 0; i < 4; i += 1) bytes[8 + i] = 'AVI '.charCodeAt(i);
    expect(isWebp(bytes)).toBe(false);
  });

  it('rejects a chunk size that points past the end of the file', () => {
    const chunk = webpChunk('VP8L', new Uint8Array(4));
    const bytes = new Uint8Array(12 + chunk.length);
    for (let i = 0; i < 4; i += 1) bytes[i] = 'RIFF'.charCodeAt(i);
    for (let i = 0; i < 4; i += 1) bytes[8 + i] = 'WEBP'.charCodeAt(i);
    bytes.set(chunk, 12);
    const view = new DataView(bytes.buffer);
    // An honest RIFF size, so the walk is not cut short before it reaches the
    // chunk. Leaving this at zero would bound the walk to nothing and the test
    // would pass without exercising the check it is named for.
    view.setUint32(4, bytes.length - 8, true);
    // Then claim far more payload in the chunk than the file holds.
    view.setUint32(16, 0x0000ffff, true);
    expect(() => parseWebpChunks(bytes)).toThrow(MalformedFileError);
  });

  it('refuses a file shorter than its RIFF header declares, and says so', async () => {
    // Asserting the message, not just that something threw. The bounds-checked
    // readers would reject a truncated file anyway, a few chunks later, with
    // "truncated ascii: needed 4 bytes at 174". This guard exists to fail at the
    // header with a reason a person can act on, so a test that accepted any
    // error would pass with the guard deleted.
    const bytes = await makeWebp({ xmp: true });
    const chunks = parseWebpChunks(bytes);
    const last = chunks[chunks.length - 1];
    expect(last).toBeDefined();
    if (!last) return;

    expect(() => parseWebpChunks(bytes.subarray(0, last.start))).toThrow(
      /truncated WebP: header declares/
    );
  });

  it('rejects an absurd chunk size rather than trying to honour it', async () => {
    const bytes = await makeWebp({ exif: { make: 'ACME' } });
    const chunk = parseWebpChunks(bytes).find((c) => c.fourcc === 'EXIF');
    expect(chunk).toBeDefined();
    // A size with the top bit set. Left unchecked this is an arithmetic hazard
    // before it is ever a bounds problem.
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    view.setUint32(chunk!.dataAt - 4, 0x80000000, true);

    // Asserting the message, not the class. Both this guard and the bounds check
    // below it throw MalformedFileError, so `toThrow(MalformedFileError)` passed
    // with the guard deleted and proved nothing.
    expect(() => parseWebpChunks(bytes)).toThrow(/chunk size 2147483648/);
  });

  it('stops cleanly on a trailing byte too short to be a chunk header', async () => {
    const clean = await makeWebp({ exif: { make: 'ACME' } });
    // Two stray bytes inside the declared RIFF size: not a chunk, not enough to
    // read one. Stopping is right; throwing would reject a file over padding.
    const padded = new Uint8Array(clean.length + 2);
    padded.set(clean);
    new DataView(padded.buffer).setUint32(4, padded.length - 8, true);

    const chunks = parseWebpChunks(padded);
    expect(chunks.map((c) => c.fourcc)).toEqual(parseWebpChunks(clean).map((c) => c.fourcc));
  });

  it('ignores anything appended past the declared RIFF size', async () => {
    // The same hiding place as JPEG's post-EOI and PNG's post-IEND trailer. The
    // walk is bounded by the declared size, so the payload is never parsed at
    // all rather than parsed and then happening to be dropped.
    const base = await makeWebp();
    const secret = new TextEncoder().encode('SECRET-PAYLOAD-AFTER-RIFF');
    const withTrailer = new Uint8Array(base.length + secret.length);
    withTrailer.set(base, 0);
    withTrailer.set(secret, base.length);

    expect(fourccs(withTrailer)).toEqual(fourccs(base));
    const stripped = stripWebp(withTrailer).bytes;
    expect(new TextDecoder().decode(stripped)).not.toContain('SECRET-PAYLOAD-AFTER-RIFF');
  });

  it('handles an odd-sized chunk without losing its pad byte', async () => {
    // An odd payload carries one pad byte. Miscounting it shifts every chunk
    // that follows, so the parse would drift rather than fail loudly.
    const bytes = await makeWebp({ xmp: true });
    const xmp = parseWebpChunks(bytes).find((c) => c.fourcc === 'XMP ');
    expect(xmp).toBeDefined();
    if (!xmp) return;
    expect(xmp.end - xmp.dataAt).toBe(xmp.dataLength + (xmp.dataLength % 2));
    // The walk still reaches the end cleanly, which it would not if the pad
    // byte had been miscounted.
    expect(fourccs(bytes)).toContain('XMP ');
  });
});
