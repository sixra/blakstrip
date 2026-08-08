/**
 * The EXIF parser, which was the least-covered module in the repo and the most
 * exposed one: it walks TIFF/IFD structures out of a file a stranger handed you
 * and turns them into the coordinates and serial numbers shown on screen.
 *
 * Two whole areas had no coverage at all. Little-endian files, which is what most
 * phones write, so half of `readerFor` was never exercised. And the Exif sub-IFD,
 * which is where a camera puts the MakerNote, the capture timestamp and the body
 * and lens serials: IFD0 alone cannot reach any of it.
 *
 * Every fixture here goes through the real parser rather than being asserted
 * against by hand, so a fixture that is subtly wrong fails instead of agreeing
 * with a bug.
 */
import { describe, expect, it } from 'vitest';
import { inspectMedia } from '../../src/lib/media';
import { MalformedFileError } from '../../src/lib/media/bytes';
import { summarizeExif, type ExifSummary } from '../../src/lib/media/exif';
import { parseJpegSegments } from '../../src/lib/media/jpeg';
import { makeJpeg } from '../support/testjpeg';

/** The TIFF header offset inside a JPEG's APP1 payload, past `Exif\0\0`. */
function tiffOffset(bytes: Uint8Array): number {
  const app1 = parseJpegSegments(bytes).find((s) => s.marker === 0xe1);
  // `payloadAt` is undefined for standalone markers like SOI, never for an APP1.
  if (app1?.payloadAt === undefined) throw new Error('fixture has no APP1 segment');
  return app1.payloadAt + 6;
}

const summarize = (bytes: Uint8Array): ExifSummary => summarizeExif(bytes, tiffOffset(bytes));

describe('byte order', () => {
  it('reads a little-endian file, which is what most phones write', async () => {
    const bytes = await makeJpeg({
      exif: {
        byteOrder: 'II',
        subIfd: { dateTimeOriginal: '2024:06:11 14:02:37' },
        make: 'ACME',
        model: 'Pixelbird 9',
        orientation: 6,
        gps: { lat: 51.5, lon: -0.12 },
      },
    });

    const summary = summarize(bytes);
    expect(summary.make).toBe('ACME');
    expect(summary.model).toBe('Pixelbird 9');
    expect(summary.orientation).toBe(6);
    // Rationals are raw bytes in the file's order, so a byte-order bug in either
    // the writer or the reader lands here as a wildly wrong coordinate.
    expect(summary.gps?.lat).toBeCloseTo(51.5, 3);
    expect(summary.gps?.lon).toBeCloseTo(-0.12, 3);
  });

  it('reads the same values from big-endian and little-endian files', async () => {
    const options = {
      make: 'ACME',
      model: 'Pixelbird 9',
      software: 'Cam 4.2',
      gps: { lat: -33.8688, lon: 151.2093 },
    } as const;

    const big = summarize(await makeJpeg({ exif: { ...options, byteOrder: 'MM' } }));
    const little = summarize(await makeJpeg({ exif: { ...options, byteOrder: 'II' } }));

    expect(little.make).toBe(big.make);
    expect(little.model).toBe(big.model);
    expect(little.software).toBe(big.software);
    expect(little.gps?.lat).toBeCloseTo(big.gps?.lat ?? 0, 6);
    expect(little.gps?.lon).toBeCloseTo(big.gps?.lon ?? 0, 6);
  });

  it('refuses a TIFF header that is neither II nor MM', async () => {
    const bytes = await makeJpeg({ exif: { make: 'ACME' } });
    const at = tiffOffset(bytes);
    bytes[at] = 0x58; // 'X'
    bytes[at + 1] = 0x58;

    expect(() => summarize(bytes)).toThrow(MalformedFileError);
  });

  it('refuses a bad TIFF magic', async () => {
    const bytes = await makeJpeg({ exif: { make: 'ACME' } });
    const at = tiffOffset(bytes);
    // Magic is the u16 after the byte-order mark, big-endian in this fixture.
    bytes[at + 2] = 0x00;
    bytes[at + 3] = 0x99;

    expect(() => summarize(bytes)).toThrow(/bad TIFF magic/);
  });
});

describe('the Exif sub-IFD', () => {
  it('finds the maker note, which IFD0 cannot reach', async () => {
    const bytes = await makeJpeg({ exif: { subIfd: { makerNote: true } } });

    expect(summarize(bytes).hasMakerNote).toBe(true);
    expect(summarize(await makeJpeg({ exif: { make: 'ACME' } })).hasMakerNote).toBe(false);
  });

  it('reports body and lens serials separately', async () => {
    const bytes = await makeJpeg({
      exif: { subIfd: { bodySerial: '042817336611', lensSerial: 'LNS-9931' } },
    });

    expect(summarize(bytes).serials).toEqual(['042817336611', 'LNS-9931']);
  });

  it('omits serials that are not there rather than reporting empties', async () => {
    const bytes = await makeJpeg({ exif: { subIfd: { bodySerial: '042817336611' } } });

    // The loop reads both tags and pushes only non-empty values; a missing lens
    // serial must not become an empty string in the audit.
    expect(summarize(bytes).serials).toEqual(['042817336611']);
  });

  it('falls back to DateTimeOriginal when IFD0 has no DateTime', async () => {
    const bytes = await makeJpeg({ exif: { subIfd: { dateTimeOriginal: '2019:03:04 09:15:00' } } });

    expect(summarize(bytes).timestamp).toBe('2019:03:04 09:15:00');
  });

  it('prefers IFD0 DateTime over DateTimeOriginal when both are present', async () => {
    // `??=` means the first one found wins, and IFD0 is read first. Worth pinning:
    // swapping the precedence would change which timestamp a user is shown.
    const bytes = await makeJpeg({
      exif: {
        dateTime: '2024:06:11 14:02:37',
        subIfd: { dateTimeOriginal: '2019:03:04 09:15:00' },
      },
    });

    expect(summarize(bytes).timestamp).toBe('2024:06:11 14:02:37');
  });

  it('surfaces sub-IFD findings through the public audit', async () => {
    // The engine's own seam, not just the internal summarizer.
    const bytes = await makeJpeg({
      exif: { subIfd: { makerNote: true, bodySerial: '042817336611' } },
    });

    const ids = inspectMedia(bytes).findings.map((f) => f.id);
    expect(ids).toContain('exif-makernote');
    expect(ids).toContain('exif-serial');
  });
});

describe('malformed values', () => {
  it('treats a zero denominator as zero rather than failing the whole audit', async () => {
    const bytes = await makeJpeg({ exif: { gps: { lat: 51.5, lon: -0.12 } } });
    const at = tiffOffset(bytes);
    const summary = summarize(bytes);
    expect(summary.gps).toBeDefined();

    // Latitude is stored as three rationals: degrees, minutes, seconds. Zero the
    // *degrees* denominator. The parse must keep going, because one broken field
    // is not a reason to report nothing at all about the file.
    const gpsIfdAt = at + findGpsIfdOffset(bytes, at);
    const rationalAt = at + readU32(bytes, gpsIfdAt + 2 + 12 + 8);
    for (let i = 4; i < 8; i += 1) bytes[rationalAt + i] = 0;

    const degraded = summarize(bytes);
    expect(degraded.gps).toBeDefined();
    // 51°30' with the degrees term dropped leaves the minutes: 30/60.
    expect(degraded.gps?.lat).toBeCloseTo(0.5, 5);
  });

  it('rejects a GPS coordinate stored with the wrong type', async () => {
    const bytes = await makeJpeg({ exif: { gps: { lat: 51.5, lon: -0.12 } } });
    const at = tiffOffset(bytes);
    const gpsIfdAt = at + findGpsIfdOffset(bytes, at);
    // Second GPS entry is latitude; rewrite its type from RATIONAL to ASCII.
    bytes[gpsIfdAt + 2 + 12 + 2] = 0x00;
    bytes[gpsIfdAt + 2 + 12 + 3] = 0x02;

    expect(() => summarize(bytes)).toThrow(/bad GPS rational/);
  });

  it('ignores an ASCII tag stored with a non-ASCII type', async () => {
    const bytes = await makeJpeg({ exif: { make: 'ACME' } });
    const at = tiffOffset(bytes);
    // First IFD0 entry is Make; rewrite its type to SHORT.
    bytes[at + 8 + 2 + 2] = 0x00;
    bytes[at + 8 + 2 + 3] = 0x03;

    // Reporting a garbled string would be worse than reporting nothing.
    expect(summarize(bytes).make).toBeUndefined();
  });
});

/** Big-endian u32, for poking at fixture bytes directly. */
function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) << 24) |
    ((bytes[at + 1] ?? 0) << 16) |
    ((bytes[at + 2] ?? 0) << 8) |
    (bytes[at + 3] ?? 0)
  );
}

/** IFD0's GPS pointer value, so a test can reach the GPS directory. */
function findGpsIfdOffset(bytes: Uint8Array, tiffAt: number): number {
  const ifd0At = tiffAt + readU32(bytes, tiffAt + 4);
  const count = ((bytes[ifd0At] ?? 0) << 8) | (bytes[ifd0At + 1] ?? 0);
  for (let i = 0; i < count; i += 1) {
    const entryAt = ifd0At + 2 + i * 12;
    const tag = ((bytes[entryAt] ?? 0) << 8) | (bytes[entryAt + 1] ?? 0);
    if (tag === 0x8825) return readU32(bytes, entryAt + 8);
  }
  throw new Error('fixture has no GPS IFD');
}
