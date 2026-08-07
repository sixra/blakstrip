/**
 * PNG container surgery: walk the chunks, report what is hiding, and rebuild the
 * file keeping only what is needed.
 *
 * Lossless for the same reason JPEG is: metadata lives in its own chunks,
 * separate from the IDAT image data, so dropping it never touches a pixel. Each
 * kept chunk is copied whole, CRC included, so no checksum needs recomputing.
 *
 * Same allowlist argument as jpeg.ts: PNG's chunk type space is open, anyone can
 * register one, and a blocklist would preserve every chunk nobody thought of.
 */
import type { Finding } from '../types';
import { ascii, concat, MalformedFileError, u32be } from './bytes';
import { exifFindings, summarizeExif } from './exif';

/** The 8-byte signature every PNG starts with. */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Chunks that decide how the image decodes or renders.
 *
 * The colour chunks are the PNG equivalent of JPEG's ICC and Adobe segments:
 * `gAMA`, `cHRM`, `sRGB` and `iCCP` govern how the stored values map to colour,
 * and dropping them shifts the image. `pHYs` carries intended physical size, so
 * removing it changes how large the image prints. None of them identify anyone.
 */
const STRUCTURAL = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'sBIT',
  'bKGD',
  'hIST',
  // APNG. These are image data, not metadata: acTL carries the frame and loop
  // counts, fcTL the per-frame size, delay and compositing, fdAT the frames
  // themselves. Dropping them turns an animation into a still image, which is
  // exactly the kind of silent damage this tool must not do.
  'acTL',
  'fcTL',
  'fdAT',
]);
const COLOR = new Set(['gAMA', 'cHRM', 'sRGB', 'iCCP', 'pHYs']);

/** Text chunks, all of which carry free-form author-supplied content. */
const TEXT = new Set(['tEXt', 'zTXt', 'iTXt']);

export interface PngChunk {
  type: string;
  /** Offset of the 4-byte length field that introduces the chunk. */
  start: number;
  /** One past the chunk's CRC. */
  end: number;
  /** Offset of the chunk's data, after length and type. */
  dataAt: number;
  dataLength: number;
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE.length) return false;
  return SIGNATURE.every((byte, i) => bytes[i] === byte);
}

/**
 * Walk a PNG's chunks.
 *
 * @throws MalformedFileError when the signature is wrong or a chunk length runs
 * past the end of the file.
 */
export function parsePngChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) throw new MalformedFileError('not a PNG: bad signature');

  const chunks: PngChunk[] = [];
  let at = SIGNATURE.length;

  while (at < bytes.length) {
    const length = u32be(bytes, at);
    // PNG caps a chunk at 2^31-1. Rejecting anything larger keeps the arithmetic
    // below inside the safe integer range on a crafted file.
    if (length > 0x7fffffff) throw new MalformedFileError(`chunk length ${length} at ${at}`);
    const type = ascii(bytes, at + 4, 4);
    const dataAt = at + 8;
    // 12 = 4 length + 4 type + 4 CRC.
    const end = at + 12 + length;
    if (end > bytes.length) throw new MalformedFileError(`chunk ${type} at ${at} runs past end`);

    chunks.push({ type, start: at, end, dataAt, dataLength: length });
    at = end;
    if (type === 'IEND') break;
  }

  // A PNG that never reaches IEND is truncated. Refusing it is the honest
  // outcome: continuing would emit a file missing its terminator, and silently
  // repairing one would hide that image data went missing with it.
  if (chunks[chunks.length - 1]?.type !== 'IEND') {
    throw new MalformedFileError('truncated PNG: no IEND chunk');
  }

  return chunks;
}

export interface PngKeepOptions {
  /** Keep the colour chunks. On by default: dropping them shifts the image. */
  keepColorProfile?: boolean;
}

type ChunkKind = 'structural' | 'color' | 'text' | 'exif' | 'time' | 'unknown';

/**
 * Exported for test: the keep/drop decision is the security boundary, so the
 * suite asserts on kinds rather than on byte lengths nobody can interpret.
 */
export function classifyPngChunk(type: string): ChunkKind {
  if (STRUCTURAL.has(type)) return 'structural';
  if (COLOR.has(type)) return 'color';
  if (TEXT.has(type)) return 'text';
  if (type === 'eXIf') return 'exif';
  if (type === 'tIME') return 'time';
  return 'unknown';
}

function isKept(kind: ChunkKind, options: PngKeepOptions): boolean {
  if (kind === 'structural') return true;
  if (kind === 'color') return options.keepColorProfile !== false;
  return false;
}

/**
 * The keyword a text chunk is filed under, e.g. "Author" or "Comment". Every
 * text chunk variant starts with a NUL-terminated Latin-1 keyword, so the same
 * read works for all three even though what follows differs.
 */
function textKeyword(bytes: Uint8Array, chunk: PngChunk): string {
  // The keyword is capped at 79 bytes by the spec, and never longer than the
  // chunk. ascii() stops at the NUL and bounds-checks the rest.
  const limit = Math.min(80, chunk.dataLength);
  return ascii(bytes, chunk.dataAt, limit) || '(unnamed)';
}

/** Report everything identifying that this PNG is carrying. */
export function inspectPng(bytes: Uint8Array): Finding[] {
  const chunks = parsePngChunks(bytes);
  const findings: Finding[] = [];

  for (const chunk of chunks) {
    switch (classifyPngChunk(chunk.type)) {
      case 'text':
        findings.push({
          id: `png-text-${chunk.type}-${chunk.start}`,
          severity: 'medium',
          category: 'metadata',
          title: `Text: ${textKeyword(bytes, chunk)}`,
          detail: `${chunk.dataLength} bytes in a ${chunk.type} chunk.`,
        });
        break;
      case 'exif':
        try {
          // A PNG eXIf chunk holds raw TIFF with no `Exif\0\0` prefix, so the
          // chunk data starts at the byte-order mark the reader expects.
          findings.push(...exifFindings(summarizeExif(bytes, chunk.dataAt)));
        } catch {
          findings.push({
            id: 'png-exif-unreadable',
            severity: 'medium',
            category: 'exif',
            title: 'Damaged EXIF chunk',
            detail: `${chunk.dataLength} bytes this tool cannot read, so its contents are unknown. It will be removed in full.`,
          });
        }
        break;
      case 'time':
        findings.push({
          id: 'png-time',
          severity: 'medium',
          category: 'metadata',
          title: 'Last modification time',
          detail: 'A tIME chunk recording when this image was last written.',
        });
        break;
      case 'unknown':
        findings.push({
          // Offset-qualified, like the text chunks above: a file can carry
          // several unknown chunks of one type, and duplicate ids would collide
          // as keys in the list the UI renders.
          id: `png-chunk-${chunk.type}-${chunk.start}`,
          severity: 'medium',
          category: 'container',
          title: `Unrecognised chunk (${chunk.type})`,
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
 * Rebuild the PNG with only the allowlisted chunks. Kept chunks are copied whole
 * including their CRC, so no checksum is recomputed and the image data is
 * bit-identical to the input's.
 */
export function stripPng(bytes: Uint8Array, options: PngKeepOptions = {}): Uint8Array {
  const chunks = parsePngChunks(bytes);
  const out: Uint8Array[] = [bytes.subarray(0, SIGNATURE.length)];

  for (const chunk of chunks) {
    if (isKept(classifyPngChunk(chunk.type), options)) {
      out.push(bytes.subarray(chunk.start, chunk.end));
    }
  }

  return concat(out);
}
