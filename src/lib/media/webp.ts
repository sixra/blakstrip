/**
 * WebP container surgery: walk the RIFF chunks, report what is hiding, and
 * rebuild the file keeping only what is needed.
 *
 * Lossless like the others, and harder in one specific way. JPEG and PNG are
 * lists of independent segments, so dropping one leaves the rest valid. A RIFF
 * file carries its own total size, and WebP's `VP8X` header carries flag bits
 * declaring which optional chunks exist. Remove `EXIF` without clearing its flag
 * and the file claims metadata a reader will then fail to find, so both have to
 * be rewritten. That is the only place this module edits bytes rather than
 * copying them.
 *
 * Layout per the container spec:
 * https://developers.google.com/speed/webp/docs/riff_container
 */
import type { Finding } from '../types';
import { ascii, concat, MalformedFileError, matches, u32le } from './bytes';
import { EXIF_PREFIX, exifFindings, summarizeExif } from './exif';
import type { KeepOptions, StripResult } from './types';

/**
 * Chunks needed to reconstruct the picture.
 *
 * `ANIM` and `ANMF` are on this list for the same reason APNG's frame chunks are
 * on PNG's: they are image data, and dropping them would turn an animation into
 * a single still frame. `ALPH` is the transparency channel. Note the trailing
 * space in `VP8 ` - it is a four-character code, not a three.
 */
const STRUCTURAL = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

/** The ICC profile: colour, not identity, so kept by default like JPEG's APP2. */
const COLOR = 'ICCP';

/**
 * VP8X flag bits, from the container spec's table. The spec numbers bits MSB
 * first, so its "bit 2" is mask 1 << (7 - 2). Written as masks here because that
 * is what the code applies, and deriving them at each use is how sign errors get
 * in.
 */
const FLAG_ICC = 0x20;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;

/** Byte offset of the RIFF size field, and what it counts from. */
const SIZE_AT = 4;
const SIZE_COUNTS_FROM = 8;

export interface WebpChunk {
  fourcc: string;
  /** Offset of the FourCC that introduces the chunk. */
  start: number;
  /** One past the payload, including the pad byte when the size is odd. */
  end: number;
  dataAt: number;
  dataLength: number;
}

export function isWebp(bytes: Uint8Array): boolean {
  return matches(bytes, 0, 'RIFF') && matches(bytes, 8, 'WEBP');
}

/**
 * Walk a WebP's chunks.
 *
 * @throws MalformedFileError when the container header is wrong or a chunk size
 * runs past the end of the file.
 */
export function parseWebpChunks(bytes: Uint8Array): WebpChunk[] {
  if (!isWebp(bytes)) throw new MalformedFileError('not a WebP: bad RIFF/WEBP header');

  // RIFF states its own length, which gives WebP a truncation check the other
  // two formats reach differently (PNG demands an IEND, JPEG fails on the marker
  // read). A file shorter than it claims has lost data, and continuing would
  // emit a confidently rebuilt fragment of it.
  const declared = u32le(bytes, SIZE_AT);
  const available = bytes.length - SIZE_COUNTS_FROM;
  if (declared > available) {
    throw new MalformedFileError(
      `truncated WebP: header declares ${declared} bytes from offset 8, file has ${available}`
    );
  }

  // Anything past the declared size is not part of the file, whatever it looks
  // like. Bounding the walk here is what keeps an appended payload from being
  // parsed at all, rather than parsed and then happening to be dropped.
  const limit = SIZE_COUNTS_FROM + declared;

  const chunks: WebpChunk[] = [];
  let at = 12;

  while (at < limit) {
    // A trailing byte or two cannot hold a header, so stop rather than throw:
    // the pad byte of the last chunk is already consumed by `end` below.
    if (at + 8 > limit) break;

    const fourcc = ascii(bytes, at, 4);
    const size = u32le(bytes, at + 4);
    if (size > 0x7fffffff) throw new MalformedFileError(`chunk size ${size} at ${at}`);
    const dataAt = at + 8;
    // Odd payloads carry a single pad byte so the next chunk starts even.
    const end = dataAt + size + (size % 2);
    if (dataAt + size > limit) {
      throw new MalformedFileError(`chunk ${fourcc} at ${at} runs past end`);
    }

    chunks.push({ fourcc, start: at, end, dataAt, dataLength: size });
    at = end;
  }

  return chunks;
}

type WebpChunkKind = 'structural' | 'color' | 'exif' | 'xmp' | 'unknown';

/**
 * Exported for test: the keep/drop decision is the security boundary, so the
 * suite asserts on kinds rather than on byte lengths nobody can interpret.
 */
export function classifyWebpChunk(fourcc: string): WebpChunkKind {
  if (STRUCTURAL.has(fourcc)) return 'structural';
  if (fourcc === COLOR) return 'color';
  if (fourcc === 'EXIF') return 'exif';
  // The XMP FourCC carries a trailing space, like `VP8 `.
  if (fourcc === 'XMP ') return 'xmp';
  return 'unknown';
}

function isKept(kind: WebpChunkKind, options: KeepOptions): boolean {
  if (kind === 'structural') return true;
  if (kind === 'color') return options.keepColorProfile !== false;
  return false;
}

/**
 * Where the TIFF header starts inside an EXIF chunk.
 *
 * The spec says the payload is Exif metadata, and most writers store raw TIFF
 * starting at the byte-order mark. Some prepend JPEG's `Exif\0\0`, so both are
 * accepted rather than failing on a file that is common in the wild.
 */
function tiffStart(bytes: Uint8Array, chunk: WebpChunk): number {
  return matches(bytes, chunk.dataAt, EXIF_PREFIX)
    ? chunk.dataAt + EXIF_PREFIX.length
    : chunk.dataAt;
}

/** Report everything identifying that this WebP is carrying. */
export function inspectWebp(bytes: Uint8Array): Finding[] {
  const chunks = parseWebpChunks(bytes);
  const findings: Finding[] = [];

  for (const chunk of chunks) {
    switch (classifyWebpChunk(chunk.fourcc)) {
      case 'exif':
        try {
          findings.push(...exifFindings(summarizeExif(bytes, tiffStart(bytes, chunk))));
        } catch {
          findings.push({
            id: 'webp-exif-unreadable',
            severity: 'medium',
            category: 'exif',
            title: 'Damaged EXIF chunk',
            detail: `${chunk.dataLength} bytes this tool cannot read, so its contents are unknown. It will be removed in full.`,
          });
        }
        break;
      case 'xmp':
        findings.push({
          id: 'webp-xmp',
          severity: 'medium',
          category: 'xmp',
          title: 'XMP metadata',
          detail: `${chunk.dataLength} bytes of editing history, authorship and tags.`,
        });
        break;
      case 'unknown':
        findings.push({
          id: `webp-chunk-${chunk.fourcc.trim()}-${chunk.start}`,
          severity: 'medium',
          category: 'container',
          title: `Unrecognised chunk (${chunk.fourcc.trim()})`,
          detail: `${chunk.dataLength} bytes this tool does not recognise. It will be removed: only chunks needed to decode the image are kept.`,
        });
        break;
      default:
        break;
    }
  }

  return findings;
}

/**
 * A copy of the VP8X chunk with the flags for chunks we removed cleared.
 *
 * Leaving a flag set for an absent chunk makes the file lie about itself, and
 * the spec tells readers to fail when the declared chunks are not there.
 */
function rewriteVp8x(bytes: Uint8Array, chunk: WebpChunk, keptIcc: boolean): Uint8Array {
  const copy = new Uint8Array(bytes.subarray(chunk.start, chunk.end));
  // 8 bytes of chunk header, then the flags byte is the payload's first.
  const flagsAt = 8;
  const flags = copy[flagsAt] ?? 0;
  let cleared = flags & ~FLAG_EXIF & ~FLAG_XMP;
  if (!keptIcc) cleared &= ~FLAG_ICC;
  copy[flagsAt] = cleared & 0xff;
  return copy;
}

/**
 * Rebuild the WebP with only the allowlisted chunks, then repair the container:
 * the RIFF size field and the VP8X flags both describe what the file contains,
 * so both change when its contents do.
 */
export function stripWebp(bytes: Uint8Array, options: KeepOptions = {}): StripResult {
  const chunks = parseWebpChunks(bytes);
  const keptIcc = options.keepColorProfile !== false && chunks.some((c) => c.fourcc === COLOR);

  const body: Uint8Array[] = [];
  for (const chunk of chunks) {
    if (!isKept(classifyWebpChunk(chunk.fourcc), options)) continue;
    body.push(
      chunk.fourcc === 'VP8X'
        ? rewriteVp8x(bytes, chunk, keptIcc)
        : bytes.subarray(chunk.start, chunk.end)
    );
  }

  const bodyLength = body.reduce((sum, part) => sum + part.length, 0);
  const header = new Uint8Array(12);
  for (let i = 0; i < 4; i += 1) header[i] = 'RIFF'.charCodeAt(i);
  for (let i = 0; i < 4; i += 1) header[8 + i] = 'WEBP'.charCodeAt(i);
  // The size field counts from offset 8, so it covers the 'WEBP' FourCC plus
  // every chunk that follows: total length minus the 8 bytes ahead of it.
  new DataView(header.buffer).setUint32(SIZE_AT, 4 + bodyLength, true);

  const out = concat([header, ...body]);
  // Cheap invariant, checked rather than assumed: a wrong size field is the one
  // corruption this rebuild can introduce, and it would only show up in another
  // decoder much later.
  if (u32le(out, SIZE_AT) !== out.length - SIZE_COUNTS_FROM) {
    throw new MalformedFileError('internal: rebuilt RIFF size does not match output length');
  }
  return { bytes: out, notes: [] };
}
