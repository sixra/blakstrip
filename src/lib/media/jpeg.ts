/**
 * JPEG container surgery: walk the marker segments, report what is hiding, and
 * rebuild the file keeping only what is needed.
 *
 * Stripping here is **lossless**. Metadata lives in its own marker segments,
 * entirely separate from the entropy-coded scan data, so removing it does not
 * touch a single pixel. Nothing in this module decodes or re-encodes an image.
 *
 * The keep/drop decision is an **allowlist**, and that is the whole security
 * argument: a blocklist preserves every segment nobody thought of, and camera
 * vendors invent those constantly. Anything not named here is dropped.
 */
import type { Finding } from '../types';
import { concat, MalformedFileError, matches, u8, u16be } from './bytes';
import { buildOrientationExif, EXIF_PREFIX, exifFindings, summarizeExif } from './exif';

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP13 = 0xed;
const APP14 = 0xee;
const COM = 0xfe;

const XMP_PREFIX = 'http://ns.adobe.com/xap/1.0/';
const IPTC_PREFIX = 'Photoshop 3.0';

export interface JpegSegment {
  marker: number;
  /** Offset of the 0xFF that introduces the marker. */
  start: number;
  /** One past the segment's last byte, including scan data for SOS. */
  end: number;
  /** Offset of the payload, after the 2-byte length. Absent for SOI/EOI. */
  payloadAt: number | undefined;
  payloadLength: number;
}

/** Markers that stand alone with no length field: SOI, EOI, TEM and the RSTn set. */
function isStandalone(marker: number): boolean {
  return marker === SOI || marker === EOI || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/**
 * Segments whose removal would change how the image decodes or renders.
 *
 * The split is on *purpose*, not on segment kind: an ICC profile and an Adobe
 * colour-transform flag look like "just metadata" but decide how the pixels are
 * interpreted, and dropping them shifts or inverts colour. Identity-bearing
 * segments (EXIF, XMP, IPTC, comments) are what this tool exists to remove.
 */
function isStructural(marker: number): boolean {
  if (isStandalone(marker)) return true;
  if (marker === SOS) return true;
  // SOF0-SOF15 (frame headers), DHT, DAC, DQT, DRI and friends all live in
  // 0xC0-0xCF and 0xDB-0xDF. None of them carry user data.
  if (marker >= 0xc0 && marker <= 0xcf) return true;
  if (marker >= 0xdb && marker <= 0xdf) return true;
  return false;
}

/**
 * Walk a JPEG's marker segments.
 *
 * @throws MalformedFileError when the file is not a JPEG or a length runs past
 * the end. Callers surface that as "we could not read this file", never as a
 * silent partial parse.
 */
export function parseJpegSegments(bytes: Uint8Array): JpegSegment[] {
  if (u8(bytes, 0) !== 0xff || u8(bytes, 1) !== SOI) {
    throw new MalformedFileError('not a JPEG: missing SOI');
  }

  const segments: JpegSegment[] = [
    { marker: SOI, start: 0, end: 2, payloadAt: undefined, payloadLength: 0 },
  ];
  let at = 2;

  while (at < bytes.length) {
    if (u8(bytes, at) !== 0xff) throw new MalformedFileError(`expected a marker at ${at}`);
    // Any number of 0xFF fill bytes may precede the marker code.
    let markerAt = at + 1;
    while (u8(bytes, markerAt) === 0xff) markerAt += 1;
    const marker = u8(bytes, markerAt);

    if (isStandalone(marker)) {
      segments.push({
        marker,
        start: at,
        end: markerAt + 1,
        payloadAt: undefined,
        payloadLength: 0,
      });
      at = markerAt + 1;
      if (marker === EOI) break;
      continue;
    }

    const length = u16be(bytes, markerAt + 1);
    // The length includes its own two bytes, so anything under 2 would not
    // advance and would spin this loop forever on a crafted file.
    if (length < 2) throw new MalformedFileError(`segment length ${length} at ${markerAt + 1}`);
    const payloadAt = markerAt + 3;
    const payloadLength = length - 2;
    let end = payloadAt + payloadLength;
    if (end > bytes.length) throw new MalformedFileError(`segment at ${at} runs past end of file`);

    if (marker === SOS) {
      // Entropy-coded data follows the header with no length of its own. It ends
      // at the next marker that is not a stuffed 0xFF00 or a restart marker.
      let scan = end;
      while (scan < bytes.length - 1) {
        if (bytes[scan] === 0xff) {
          const next = bytes[scan + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
        }
        scan += 1;
      }
      end = Math.min(scan, bytes.length);
    }

    segments.push({ marker, start: at, end, payloadAt, payloadLength });
    at = end;
  }

  return segments;
}

/** Does this APP segment's payload begin with `prefix`? */
function payloadHas(bytes: Uint8Array, segment: JpegSegment, prefix: string): boolean {
  return segment.payloadAt !== undefined && matches(bytes, segment.payloadAt, prefix);
}

export interface JpegKeepOptions {
  /**
   * Keep the ICC colour profile. On by default: it is not identifying, and
   * dropping it visibly shifts colour on wide-gamut images.
   */
  keepColorProfile?: boolean;
}

/** What a segment is, for both the keep decision and the audit wording. */
type SegmentKind =
  'structural' | 'jfif' | 'icc' | 'adobe' | 'exif' | 'xmp' | 'iptc' | 'comment' | 'unknown';

/**
 * Exported for test: the keep/drop decision is the security boundary, and the
 * suite asserts on kinds directly so a misclassification shows up as a named
 * failure rather than as a byte-length difference nobody can interpret.
 */
export function classifyJpegSegment(bytes: Uint8Array, segment: JpegSegment): SegmentKind {
  if (isStructural(segment.marker)) return 'structural';
  if (segment.marker === APP0 && payloadHas(bytes, segment, 'JFIF')) return 'jfif';
  if (segment.marker === APP2 && payloadHas(bytes, segment, 'ICC_PROFILE')) return 'icc';
  if (segment.marker === APP14 && payloadHas(bytes, segment, 'Adobe')) return 'adobe';
  if (segment.marker === APP1 && payloadHas(bytes, segment, EXIF_PREFIX)) return 'exif';
  if (segment.marker === APP1 && payloadHas(bytes, segment, XMP_PREFIX)) return 'xmp';
  if (segment.marker === APP13 && payloadHas(bytes, segment, IPTC_PREFIX)) return 'iptc';
  if (segment.marker === COM) return 'comment';
  return 'unknown';
}

function isKept(kind: SegmentKind, options: JpegKeepOptions): boolean {
  switch (kind) {
    case 'structural':
    case 'jfif':
    case 'adobe':
      return true;
    case 'icc':
      return options.keepColorProfile !== false;
    default:
      return false;
  }
}

/** Report everything identifying that this JPEG is carrying. */
export function inspectJpeg(bytes: Uint8Array): Finding[] {
  const segments = parseJpegSegments(bytes);
  const findings: Finding[] = [];

  for (const segment of segments) {
    const kind = classifyJpegSegment(bytes, segment);
    switch (kind) {
      case 'exif': {
        if (segment.payloadAt === undefined) break;
        try {
          // EXIF offsets are relative to the TIFF header, which follows the prefix.
          findings.push(
            ...exifFindings(summarizeExif(bytes, segment.payloadAt + EXIF_PREFIX.length))
          );
        } catch {
          // An EXIF block we cannot read must still be reported, not thrown on.
          // The strip removes it either way, so refusing to describe the file
          // would lose every other finding and offer nothing in exchange, and
          // silence would read as "nothing here" on a block that plainly exists.
          findings.push({
            id: 'exif-unreadable',
            severity: 'medium',
            category: 'exif',
            title: 'Damaged EXIF block',
            detail: `${segment.payloadLength} bytes this tool cannot read, so its contents are unknown. It will be removed in full.`,
          });
        }
        break;
      }
      case 'xmp':
        findings.push({
          id: 'jpeg-xmp',
          severity: 'medium',
          category: 'xmp',
          title: 'XMP metadata',
          detail: `${segment.payloadLength} bytes of editing history, authorship and tags.`,
        });
        break;
      case 'iptc':
        findings.push({
          id: 'jpeg-iptc',
          severity: 'medium',
          category: 'iptc',
          title: 'IPTC / Photoshop metadata',
          detail: `${segment.payloadLength} bytes of captions, credits and keywords.`,
        });
        break;
      case 'comment':
        findings.push({
          id: 'jpeg-comment',
          severity: 'medium',
          category: 'metadata',
          title: 'Comment block',
          detail: `${segment.payloadLength} bytes of free text.`,
        });
        break;
      case 'unknown':
        findings.push({
          // Offset-qualified: a file can carry several unknown segments sharing
          // one marker, and duplicate ids would collide as keys in the list the
          // UI renders.
          id: `jpeg-app-${segment.marker.toString(16)}-${segment.start}`,
          severity: 'medium',
          category: 'container',
          title: `Unrecognised segment (0x${segment.marker.toString(16).toUpperCase()})`,
          detail: `${segment.payloadLength} bytes this tool does not recognise. It will be removed: only segments needed to decode the image are kept.`,
        });
        break;
      default:
        break;
    }
  }

  return findings;
}

export interface JpegStripResult {
  bytes: Uint8Array;
  /** True when an orientation-only EXIF block was re-added. */
  keptOrientation: boolean;
}

/**
 * Rebuild the JPEG with only the allowlisted segments.
 *
 * The scan data is copied verbatim, so the output's pixels are bit-identical to
 * the input's. Verified by test rather than asserted.
 */
export function stripJpeg(bytes: Uint8Array, options: JpegKeepOptions = {}): JpegStripResult {
  const segments = parseJpegSegments(bytes);
  const chunks: Uint8Array[] = [];
  let keptOrientation = false;

  for (const segment of segments) {
    const kind = classifyJpegSegment(bytes, segment);

    // The one rebuild: a photo stored rotated needs its Orientation tag or it
    // displays sideways. Emitted in the original block's place, so it keeps
    // whatever position in the segment order the camera chose.
    if (kind === 'exif' && segment.payloadAt !== undefined) {
      let orientation: number | undefined;
      try {
        orientation = summarizeExif(bytes, segment.payloadAt + EXIF_PREFIX.length).orientation;
      } catch {
        // An EXIF block we cannot parse is one we certainly cannot preserve a
        // tag from. Dropping it whole is the safe direction.
        orientation = undefined;
      }
      if (orientation !== undefined && orientation > 1) {
        const payload = buildOrientationExif(orientation);
        const header = new Uint8Array(4);
        header[0] = 0xff;
        header[1] = APP1;
        header[2] = ((payload.length + 2) >> 8) & 0xff;
        header[3] = (payload.length + 2) & 0xff;
        chunks.push(header, payload);
        keptOrientation = true;
      }
      continue;
    }

    if (isKept(kind, options)) chunks.push(bytes.subarray(segment.start, segment.end));
  }

  return { bytes: concat(chunks), keptOrientation };
}
