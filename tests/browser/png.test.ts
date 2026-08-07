import { describe, expect, it } from 'vitest';
import { MalformedFileError } from '../../src/lib/media/bytes';
import {
  classifyPngChunk,
  inspectPng,
  isPng,
  parsePngChunks,
  stripPng,
} from '../../src/lib/media/png';
import { decodeToPixels } from '../support/decode';
import { makePng, pngChunk } from '../support/testpng';

function findingIds(bytes: Uint8Array): string[] {
  return inspectPng(bytes).map((f) => f.id);
}

function types(bytes: Uint8Array): string[] {
  return parsePngChunks(bytes).map((c) => c.type);
}

describe('png audit', () => {
  it('finds every planted leak vector', async () => {
    const bytes = await makePng({
      text: { Author: 'Jane Doe', Comment: 'internal only' },
      exif: { make: 'ACME', gps: { lat: 44.8125, lon: 20.4612 } },
      time: true,
      unknownChunk: true,
    });

    const ids = findingIds(bytes);
    expect(ids).toEqual(expect.arrayContaining(['exif-gps', 'exif-device', 'png-time']));
    expect(ids.filter((id) => id.startsWith('png-text-'))).toHaveLength(2);
    expect(ids.some((id) => id.startsWith('png-chunk-vNDr'))).toBe(true);
  });

  it('gives every finding a distinct id, even for repeated chunk types', async () => {
    // Duplicate ids would collide as keys in the list the UI renders, so the
    // offset qualifies them.
    const bytes = await makePng({ text: { Author: 'Jane', Comment: 'note' }, unknownChunk: true });
    const ids = findingIds(bytes);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names the keyword a text chunk is filed under', async () => {
    const bytes = await makePng({ text: { Author: 'Jane Doe' } });
    const text = inspectPng(bytes).find((f) => f.id.startsWith('png-text-'));
    expect(text?.title).toBe('Text: Author');
  });

  it('reads GPS out of an eXIf chunk, which stores raw TIFF unlike JPEG', async () => {
    const bytes = await makePng({ exif: { gps: { lat: 44.8125, lon: 20.4612 } } });
    const gps = inspectPng(bytes).find((f) => f.id === 'exif-gps');
    expect(gps?.severity).toBe('high');
    const [lat, lon] = (gps?.detail ?? '').split(', ').map(Number);
    expect(lat).toBeCloseTo(44.8125, 3);
    expect(lon).toBeCloseTo(20.4612, 3);
  });

  it('reports unreadable EXIF instead of refusing to audit the file', async () => {
    const bytes = await makePng({ exif: { make: 'ACME' }, text: { Comment: 'still readable' } });
    const exif = parsePngChunks(bytes).find((c) => c.type === 'eXIf');
    const copy = new Uint8Array(bytes);
    // Break the II/MM byte-order mark at the very start of the chunk data.
    if (exif) copy[exif.dataAt] = 0x00;

    const ids = inspectPng(copy).map((f) => f.id);
    expect(ids).toContain('png-exif-unreadable');
    expect(ids.some((id) => id.startsWith('png-text-'))).toBe(true);
  });

  it('finds nothing in an image that carries nothing', async () => {
    expect(findingIds(await makePng())).toEqual([]);
  });
});

describe('png strip', () => {
  it('removes every identifying chunk and verifies clean', async () => {
    const bytes = await makePng({
      text: { Author: 'Jane Doe', Comment: 'internal only' },
      exif: { make: 'ACME', gps: { lat: 44.8, lon: 20.4 } },
      time: true,
      unknownChunk: true,
    });
    expect(findingIds(bytes).length).toBeGreaterThan(0);

    const stripped = stripPng(bytes);

    // Re-inspecting the output is the proof, not a claim about the input.
    expect(inspectPng(stripped)).toEqual([]);
    for (const gone of ['tEXt', 'eXIf', 'tIME', 'vNDr']) {
      expect(types(stripped)).not.toContain(gone);
    }
    expect(types(stripped)).toContain('IHDR');
    expect(types(stripped)).toContain('IDAT');
    expect(types(stripped)).toContain('IEND');
  });

  it('drops an unrecognised chunk, because the allowlist names what stays', async () => {
    const bytes = await makePng({ unknownChunk: true });
    expect(types(bytes)).toContain('vNDr');
    expect(types(stripPng(bytes))).not.toContain('vNDr');
  });

  it('is lossless: the IDAT chunks are byte-identical', async () => {
    const bytes = await makePng({ text: { Author: 'Jane' }, time: true });
    const stripped = stripPng(bytes);

    const idatOf = (buf: Uint8Array): Uint8Array[] =>
      parsePngChunks(buf)
        .filter((c) => c.type === 'IDAT')
        .map((c) => buf.subarray(c.start, c.end));

    // Not "the pixels look the same" but "the compressed bytes were never
    // touched", including each chunk's original CRC.
    expect(idatOf(stripped)).toEqual(idatOf(bytes));
  });

  it('decodes to identical pixels after stripping', async () => {
    const bytes = await makePng({ text: { Author: 'Jane' }, exif: { make: 'ACME' } });
    expect(await decodeToPixels(stripPng(bytes), 'image/png')).toEqual(
      await decodeToPixels(bytes, 'image/png')
    );
  });

  it('keeps the colour chunks by default and drops them only when asked', async () => {
    const bytes = await makePng({ gamma: true, text: { Author: 'Jane' } });
    // Dropping gAMA shifts how the stored values map to colour, so it is not
    // identity data and must survive the default strip.
    expect(types(stripPng(bytes))).toContain('gAMA');
    expect(types(stripPng(bytes, { keepColorProfile: false }))).not.toContain('gAMA');
  });

  it('leaves an already-clean file structurally intact', async () => {
    const bytes = await makePng();
    expect(types(stripPng(bytes))).toEqual(types(bytes));
  });
});

describe('png parser hostility', () => {
  it('rejects a file that is not a PNG', () => {
    expect(isPng(new Uint8Array([1, 2, 3, 4]))).toBe(false);
    expect(() => parsePngChunks(new Uint8Array([1, 2, 3, 4]))).toThrow(MalformedFileError);
  });

  it('rejects a chunk length that points past the end of the file', () => {
    const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunk = pngChunk('IHDR', new Uint8Array(13));
    const bytes = new Uint8Array(signature.length + chunk.length);
    bytes.set(signature, 0);
    bytes.set(chunk, signature.length);
    // Claim a length far larger than the file: a parser that trusted it would
    // read whatever followed in memory.
    new DataView(bytes.buffer).setUint32(signature.length, 0x0000ffff);
    expect(() => parsePngChunks(bytes)).toThrow(MalformedFileError);
  });

  it('rejects an absurd chunk length rather than overflowing the arithmetic', () => {
    const bytes = new Uint8Array(8 + 12);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(bytes.buffer).setUint32(8, 0xffffffff);
    expect(() => parsePngChunks(bytes)).toThrow(MalformedFileError);
  });

  it('drops anything appended after IEND', async () => {
    // Same hiding place as JPEG's post-EOI trailer: decoders stop at IEND, so
    // the payload is invisible but travels with the file.
    const base = await makePng();
    const secret = new TextEncoder().encode('SECRET-PAYLOAD-AFTER-IEND');
    const withTrailer = new Uint8Array(base.length + secret.length);
    withTrailer.set(base, 0);
    withTrailer.set(secret, base.length);

    const stripped = stripPng(withTrailer);
    expect(new TextDecoder().decode(stripped)).not.toContain('SECRET-PAYLOAD-AFTER-IEND');
  });
});

describe('png chunk classification', () => {
  it('treats colour chunks as rendering, not identity', () => {
    for (const type of ['gAMA', 'cHRM', 'sRGB', 'iCCP', 'pHYs']) {
      expect(classifyPngChunk(type)).toBe('color');
    }
  });

  it('treats every text variant as identity', () => {
    for (const type of ['tEXt', 'zTXt', 'iTXt']) {
      expect(classifyPngChunk(type)).toBe('text');
    }
  });

  it('treats anything it does not know as unknown, so the allowlist drops it', () => {
    expect(classifyPngChunk('vNDr')).toBe('unknown');
    expect(classifyPngChunk('caBX')).toBe('unknown');
  });

  it('keeps APNG animation chunks, which are image data and not metadata', () => {
    // Dropping these turns an animation into a still image: real damage to the
    // picture, done silently, by a tool that promises only to remove metadata.
    for (const type of ['acTL', 'fcTL', 'fdAT']) {
      expect(classifyPngChunk(type)).toBe('structural');
    }
  });
});

describe('png truncation', () => {
  it('refuses a file that never reaches IEND', async () => {
    // Continuing would emit a PNG with no terminator; appending one would hide
    // that image data went missing with it. Refusing says so out loud.
    const base = await makePng();
    const iend = parsePngChunks(base).find((c) => c.type === 'IEND');
    expect(iend).toBeDefined();
    if (!iend) return;
    expect(() => parsePngChunks(base.subarray(0, iend.start))).toThrow(MalformedFileError);
  });
});
