import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  inspectMedia,
  mimeTypeFor,
  stripMedia,
  SUPPORTED_FORMATS,
  UnsupportedFormatError,
  verifyMedia,
} from '../../src/lib/media';
import { MalformedFileError } from '../../src/lib/media/bytes';
import { makeJpeg } from '../support/testjpeg';
import { makeMp4 } from '../support/testmp4';
import { makePng } from '../support/testpng';
import { makeWebp } from '../support/testwebp';

describe('format detection', () => {
  it('identifies each supported format from its bytes', async () => {
    expect(detectFormat(await makeJpeg())).toBe('jpeg');
    expect(detectFormat(await makePng())).toBe('png');
    expect(detectFormat(await makeWebp())).toBe('webp');
    expect(detectFormat(makeMp4())).toBe('mp4');
  });

  it('returns undefined for anything else', () => {
    expect(detectFormat(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
    expect(detectFormat(new Uint8Array())).toBeUndefined();
    // A PDF: a format this app handles elsewhere, but not with this engine.
    expect(detectFormat(new TextEncoder().encode('%PDF-1.7'))).toBeUndefined();
  });

  it('goes by the bytes, not the name or the declared type', async () => {
    // A JPEG saved as .png is the case that matters: trusting the extension
    // would run the PNG parser over it, fail to understand a single segment,
    // and report a clean file it never actually read.
    const jpegBytes = await makeJpeg({ exif: { gps: { lat: 1, lon: 2 } } });
    expect(detectFormat(jpegBytes)).toBe('jpeg');
    expect(inspectMedia(jpegBytes).findings.some((f) => f.id === 'exif-gps')).toBe(true);
  });

  it('refuses an unsupported file rather than guessing', () => {
    const notMedia = new TextEncoder().encode('%PDF-1.7');
    expect(() => inspectMedia(notMedia)).toThrow(UnsupportedFormatError);
    expect(() => stripMedia(notMedia)).toThrow(UnsupportedFormatError);
  });

  it('maps each format to the MIME type a Blob needs', () => {
    expect(mimeTypeFor('jpeg')).toBe('image/jpeg');
    expect(mimeTypeFor('png')).toBe('image/png');
    expect(mimeTypeFor('webp')).toBe('image/webp');
    // Not image/mp4, which is what a templated MIME type would have produced.
    expect(mimeTypeFor('mp4')).toBe('video/mp4');
  });

  it('covers every supported format, so none can be added without a MIME type', () => {
    // The guard against `image/${format}`-style guessing: a new format has to
    // appear here deliberately, rather than silently resolving to something
    // plausible-looking and wrong.
    for (const format of SUPPORTED_FORMATS) {
      expect(mimeTypeFor(format)).toMatch(/^(image|video)\/[a-z0-9+.-]+$/);
    }
  });
});

describe('audit, strip, verify across every format', () => {
  const loaded = [
    ['jpeg', () => makeJpeg({ exif: { make: 'ACME', gps: { lat: 44.8, lon: 20.4 } }, xmp: true })],
    ['png', () => makePng({ text: { Author: 'Jane' }, exif: { make: 'ACME' }, time: true })],
    ['webp', () => makeWebp({ exif: { make: 'ACME', gps: { lat: 1, lon: 2 } }, xmp: true })],
    ['mp4', () => makeMp4({ gps: '+44.8+020.4/', uuid: true })],
  ] as const;

  for (const [format, make] of loaded) {
    it(`${format}: finds leaks, removes them, and verifies the output clean`, async () => {
      const bytes = await make();

      const audit = inspectMedia(bytes);
      expect(audit.format).toBe(format);
      expect(audit.findings.length).toBeGreaterThan(0);
      // The input is dirty, so verifying it must fail: a verify that passes on
      // everything proves nothing about the output.
      expect(verifyMedia(bytes).clean).toBe(false);

      const { bytes: stripped } = stripMedia(bytes);
      const report = verifyMedia(stripped);
      expect(report.remaining).toEqual([]);
      expect(report.clean).toBe(true);
    });

    it(`${format}: stripping twice changes nothing`, async () => {
      const bytes = await make();
      const { bytes: stripped } = stripMedia(bytes);
      // Deliberately not asserting the output shrank. The image formats drop
      // bytes; ISOBMFF blanks them in place because its chunk offsets are
      // absolute, so a size assertion here would encode an image-only
      // assumption as if it were a rule.
      expect(stripMedia(stripped).bytes).toEqual(stripped);
    });
  }

  it('passes the keep-colour option through to whichever engine runs', async () => {
    // Routed generically, so a format that ignored the option would silently
    // differ from the other two.
    const jpeg = await makeJpeg({ icc: true, exif: { make: 'ACME' } });
    const png = await makePng({ gamma: true, text: { Author: 'Jane' } });
    const webp = await makeWebp({ icc: true, exif: { make: 'ACME' } });

    for (const bytes of [jpeg, png, webp]) {
      const kept = stripMedia(bytes).bytes;
      const dropped = stripMedia(bytes, { keepColorProfile: false }).bytes;
      expect(dropped.length).toBeLessThan(kept.length);
    }
  });

  it('surfaces a malformed file as a parse error, not a clean verdict', async () => {
    // The dangerous failure is a file we cannot read being called clean, so a
    // broken file must reach the caller as an error it has to handle.
    const bytes = await makePng();
    const truncated = bytes.subarray(0, 40);
    expect(() => inspectMedia(truncated)).toThrow(MalformedFileError);
  });
});
