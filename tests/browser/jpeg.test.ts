import { describe, expect, it } from 'vitest';
import { MalformedFileError, u8, u16be } from '../../src/lib/media/bytes';
import { EXIF_PREFIX, summarizeExif } from '../../src/lib/media/exif';
import {
  classifySegment,
  inspectJpeg,
  parseJpegSegments,
  stripJpeg,
} from '../../src/lib/media/jpeg';
import { decodeToPixels } from '../support/decode';
import { makeJpeg } from '../support/testjpeg';

function findingIds(bytes: Uint8Array): string[] {
  return inspectJpeg(bytes).map((f) => f.id);
}

function kinds(bytes: Uint8Array): string[] {
  return parseJpegSegments(bytes).map((s) => classifySegment(bytes, s));
}

describe('jpeg audit', () => {
  it('finds every planted leak vector', async () => {
    const bytes = await makeJpeg({
      exif: {
        make: 'ACME',
        model: 'Pocket 9',
        software: 'RetouchPro 4',
        dateTime: '2026:03:14 09:26:53',
        gps: { lat: 44.8125, lon: 20.4612 },
        thumbnailBytes: 4096,
      },
      xmp: true,
      iptc: true,
      comment: 'internal only',
      unknownApp: true,
    });

    expect(findingIds(bytes)).toEqual(
      expect.arrayContaining([
        'exif-gps',
        'exif-thumbnail',
        'exif-device',
        'exif-timestamp',
        'exif-software',
        'jpeg-xmp',
        'jpeg-iptc',
        'jpeg-comment',
        'jpeg-app-e7',
      ])
    );
  });

  it('reports GPS as coordinates a person can recognise', async () => {
    const bytes = await makeJpeg({ exif: { gps: { lat: 44.8125, lon: 20.4612 } } });
    const gps = inspectJpeg(bytes).find((f) => f.id === 'exif-gps');
    expect(gps?.severity).toBe('high');
    // Round-trips through degrees/minutes/seconds rationals, so allow the
    // hundredth-of-a-second quantisation the format imposes.
    const [lat, lon] = (gps?.detail ?? '').split(', ').map(Number);
    expect(lat).toBeCloseTo(44.8125, 3);
    expect(lon).toBeCloseTo(20.4612, 3);
  });

  it('reads southern and western hemispheres as negative', async () => {
    const bytes = await makeJpeg({ exif: { gps: { lat: -33.8688, lon: -70.6693 } } });
    const [lat, lon] = (inspectJpeg(bytes).find((f) => f.id === 'exif-gps')?.detail ?? '')
      .split(', ')
      .map(Number);
    expect(lat).toBeCloseTo(-33.8688, 3);
    expect(lon).toBeCloseTo(-70.6693, 3);
  });

  it('finds nothing in an image that carries nothing', async () => {
    expect(findingIds(await makeJpeg())).toEqual([]);
  });
});

describe('jpeg strip', () => {
  it('removes every identifying segment and verifies clean', async () => {
    const bytes = await makeJpeg({
      exif: { make: 'ACME', gps: { lat: 44.8, lon: 20.4 }, thumbnailBytes: 2048 },
      xmp: true,
      iptc: true,
      comment: 'internal only',
      unknownApp: true,
    });
    expect(findingIds(bytes).length).toBeGreaterThan(0);

    const { bytes: stripped } = stripJpeg(bytes);

    // Re-inspecting the *output* is the proof, not a claim about the input.
    expect(inspectJpeg(stripped)).toEqual([]);
    expect(kinds(stripped)).not.toContain('exif');
    expect(kinds(stripped)).not.toContain('xmp');
    expect(kinds(stripped)).not.toContain('iptc');
    expect(kinds(stripped)).not.toContain('comment');
    expect(kinds(stripped)).not.toContain('unknown');
    expect(stripped.length).toBeLessThan(bytes.length);
  });

  it('drops an unrecognised vendor segment, because the allowlist names what stays', async () => {
    const bytes = await makeJpeg({ unknownApp: true });
    expect(kinds(bytes)).toContain('unknown');
    expect(kinds(stripJpeg(bytes).bytes)).not.toContain('unknown');
  });

  it('is lossless: the entropy-coded scan data is byte-identical', async () => {
    const bytes = await makeJpeg({ exif: { make: 'ACME' }, xmp: true, comment: 'x' });
    const { bytes: stripped } = stripJpeg(bytes);

    const scanOf = (buf: Uint8Array): Uint8Array => {
      const sos = parseJpegSegments(buf).find((s) => s.marker === 0xda);
      if (!sos) throw new Error('no SOS');
      return buf.subarray(sos.start, sos.end);
    };

    // Not "the pixels look the same" but "the compressed bytes were never
    // touched", which is what makes this a lossless strip rather than a re-encode.
    expect(scanOf(stripped)).toEqual(scanOf(bytes));
  });

  it('decodes to identical pixels after stripping', async () => {
    const bytes = await makeJpeg({ exif: { make: 'ACME', gps: { lat: 1, lon: 2 } }, iptc: true });
    const { bytes: stripped } = stripJpeg(bytes);
    expect(await decodeToPixels(stripped, 'image/jpeg')).toEqual(
      await decodeToPixels(bytes, 'image/jpeg')
    );
  });

  it('keeps the colour profile by default and drops it only when asked', async () => {
    const bytes = await makeJpeg({ icc: true, exif: { make: 'ACME' } });
    // Dropping ICC shifts colour on wide-gamut images, so it is not identity
    // data and must survive the default strip.
    expect(kinds(stripJpeg(bytes).bytes)).toContain('icc');
    expect(kinds(stripJpeg(bytes, { keepColorProfile: false }).bytes)).not.toContain('icc');
  });

  it('preserves a rotation so the photo does not come back sideways', async () => {
    const bytes = await makeJpeg({
      exif: { orientation: 6, make: 'ACME', dateTime: '2026:01:01' },
    });
    const { bytes: stripped, keptOrientation } = stripJpeg(bytes);

    expect(keptOrientation).toBe(true);
    // The rebuilt block carries the rotation and nothing else: no device, no
    // time, no location.
    expect(inspectJpeg(stripped)).toEqual([]);
    const exif = parseJpegSegments(stripped).find((s) => classifySegment(stripped, s) === 'exif');
    expect(exif).toBeDefined();
    expect(exif?.payloadLength).toBeLessThan(64);
  });

  it('does not re-add an EXIF block when the orientation is the default', async () => {
    const bytes = await makeJpeg({ exif: { orientation: 1, make: 'ACME' } });
    const { bytes: stripped, keptOrientation } = stripJpeg(bytes);
    expect(keptOrientation).toBe(false);
    expect(kinds(stripped)).not.toContain('exif');
  });

  it('leaves an already-clean file structurally intact', async () => {
    const bytes = await makeJpeg();
    const { bytes: stripped } = stripJpeg(bytes);
    expect(kinds(stripped)).toEqual(kinds(bytes));
  });
});

describe('bounds-checked readers', () => {
  const four = new Uint8Array([1, 2, 3, 4]);

  // A range-only guard passes NaN, because `NaN < 0` and `NaN + n > len` are
  // both false. The read then yields `undefined` typed as `number` and shows up
  // as 0 somewhere much later, which is the exact failure these readers exist
  // to prevent.
  it('rejects a NaN offset rather than reading undefined', () => {
    expect(() => u8(four, Number.NaN)).toThrow(MalformedFileError);
    expect(() => u16be(four, Number.NaN)).toThrow(MalformedFileError);
  });

  it('rejects a fractional offset rather than silently reading 0', () => {
    expect(() => u16be(four, 0.5)).toThrow(MalformedFileError);
  });

  it('rejects a negative offset', () => {
    expect(() => u8(four, -1)).toThrow(MalformedFileError);
  });

  it('rejects a read that runs past the end', () => {
    expect(() => u16be(four, 3)).toThrow(MalformedFileError);
  });
});

describe('jpeg parser hostility', () => {
  it('rejects a file that is not a JPEG', () => {
    expect(() => parseJpegSegments(new Uint8Array([1, 2, 3, 4]))).toThrow(MalformedFileError);
  });

  it('drops anything appended after EOI', async () => {
    // Appending payload past the end-of-image marker is a real hiding place:
    // decoders stop at EOI, so the data is invisible but travels with the file.
    const base = await makeJpeg();
    const secret = new TextEncoder().encode('SECRET-PAYLOAD-AFTER-EOI');
    const withTrailer = new Uint8Array(base.length + secret.length);
    withTrailer.set(base, 0);
    withTrailer.set(secret, base.length);

    const { bytes: stripped } = stripJpeg(withTrailer);
    expect(new TextDecoder().decode(stripped)).not.toContain('SECRET-PAYLOAD-AFTER-EOI');
  });

  it('rejects a truncated file rather than reading past the end', async () => {
    const bytes = await makeJpeg({ exif: { make: 'ACME' } });
    expect(() => parseJpegSegments(bytes.subarray(0, 12))).toThrow(MalformedFileError);
  });

  it('rejects a segment length that points past the end of the file', () => {
    // SOI then an APP1 claiming 60000 bytes in a file that has none of them: a
    // parser that trusted the length would read whatever followed in memory.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xea, 0x60, 0x00, 0x00]);
    expect(() => parseJpegSegments(bytes)).toThrow(MalformedFileError);
  });

  it('rejects a zero length instead of looping forever', () => {
    // length < 2 would not advance the cursor: the guard is what stops a crafted
    // file from hanging the tab.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0xff, 0xd9]);
    expect(() => parseJpegSegments(bytes)).toThrow(MalformedFileError);
  });

  it('survives EXIF whose TIFF header is corrupt', async () => {
    const bytes = await makeJpeg({ exif: { make: 'ACME' } });
    const segments = parseJpegSegments(bytes);
    const exif = segments.find((s) => classifySegment(bytes, s) === 'exif');
    const copy = new Uint8Array(bytes);
    // Break the II/MM byte-order mark inside an otherwise valid segment.
    if (exif?.payloadAt !== undefined) copy[exif.payloadAt + 6] = 0x00;
    // The strip must still succeed, dropping the unreadable block entirely.
    expect(() => stripJpeg(copy)).not.toThrow();
    expect(kinds(stripJpeg(copy).bytes)).not.toContain('exif');
  });

  it('reports unreadable EXIF instead of refusing to audit the file', async () => {
    const bytes = await makeJpeg({ exif: { make: 'ACME' }, comment: 'still readable' });
    const exif = parseJpegSegments(bytes).find((s) => classifySegment(bytes, s) === 'exif');
    const copy = new Uint8Array(bytes);
    if (exif?.payloadAt !== undefined) copy[exif.payloadAt + 6] = 0x00;

    // Throwing here would lose the comment finding too, and leave the user with
    // nothing on a file the strip handles perfectly well.
    const ids = inspectJpeg(copy).map((f) => f.id);
    expect(ids).toContain('exif-unreadable');
    expect(ids).toContain('jpeg-comment');
  });
});

describe('exif fixture builder', () => {
  // Every assertion in this file rests on the fixtures carrying what they claim,
  // so the builder is checked against the real parser rather than trusted. This
  // already caught one bug: values of 4 bytes or fewer must sit inline in the
  // entry rather than behind a pointer, and writing them out-of-line produced a
  // file the parser read differently from the way it was written.
  it('round-trips its values through the real parser', async () => {
    const bytes = await makeJpeg({
      exif: {
        make: 'ACME',
        model: 'Pocket 9',
        orientation: 8,
        gps: { lat: -33.8688, lon: 151.2093 },
      },
    });

    const exif = parseJpegSegments(bytes).find((s) => classifySegment(bytes, s) === 'exif');
    const payloadAt = exif?.payloadAt;
    expect(payloadAt).toBeDefined();
    if (payloadAt === undefined) return;

    const summary = summarizeExif(bytes, payloadAt + EXIF_PREFIX.length);
    expect(summary.orientation).toBe(8);
    expect(summary.make).toBe('ACME');
    expect(summary.model).toBe('Pocket 9');
    expect(summary.gps?.lat).toBeCloseTo(-33.8688, 3);
    expect(summary.gps?.lon).toBeCloseTo(151.2093, 3);
  });
});
