/**
 * WebP fixtures with planted metadata.
 *
 * Unlike the JPEG and PNG fixtures, these are assembled rather than spliced. A
 * simple WebP from the browser's encoder has no `VP8X` header at all, and the
 * flag bits in that header are the thing most worth testing, so the container is
 * built around a real encoded image instead.
 */
import { buildExifPayload, type ExifOptions } from './testjpeg';

const FLAG_ICC = 0x20;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;

function fourcc(text: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) out[i] = text.charCodeAt(i);
  return out;
}

/** One RIFF chunk: FourCC, little-endian size, payload, pad byte when odd. */
export function webpChunk(type: string, data: Uint8Array): Uint8Array {
  const padded = data.length % 2;
  const out = new Uint8Array(8 + data.length + padded);
  out.set(fourcc(type), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** The 10-byte VP8X payload: flags, 3 reserved, canvas width-1, height-1. */
function vp8xPayload(flags: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(10);
  out[0] = flags;
  const w = width - 1;
  const h = height - 1;
  out[4] = w & 0xff;
  out[5] = (w >> 8) & 0xff;
  out[6] = (w >> 16) & 0xff;
  out[7] = h & 0xff;
  out[8] = (h >> 8) & 0xff;
  out[9] = (h >> 16) & 0xff;
  return out;
}

/** A real VP8L/VP8 bitstream chunk, taken from the browser's own encoder. */
async function encodedImageChunk(width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#2f4f4f');
  gradient.addColorStop(1, '#ff7f50');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp'));
  if (!blob) throw new Error('toBlob returned null: this browser cannot encode WebP');
  const encoded = new Uint8Array(await blob.arrayBuffer());

  // Chrome does not emit the "simple" one-chunk layout: it writes VP8X, ICCP and
  // then VP8 . Taking everything after the 12-byte header would hand back a
  // second VP8X and produce a file no decoder accepts, so find the bitstream
  // chunk and lift out only that. Walked independently of the parser under test,
  // so a bug there cannot quietly make the fixtures agree with it.
  return findChunk(encoded, (type) => type === 'VP8 ' || type === 'VP8L');
}

/** Minimal independent RIFF walk, used only to pull a chunk out of a fixture. */
function findChunk(bytes: Uint8Array, match: (type: string) => boolean): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  while (at + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    const end = at + 8 + size + (size % 2);
    if (match(type)) return bytes.subarray(at, end);
    at = end;
  }
  throw new Error('no matching chunk in the encoded image');
}

export interface WebpFixtureOptions {
  exif?: ExifOptions;
  xmp?: boolean;
  icc?: boolean;
  /**
   * Keep JPEG's `Exif\0\0` prefix in front of the TIFF header.
   *
   * Both shapes are real: most writers store raw TIFF from the byte-order mark,
   * some prepend the prefix. The parser accepts either, and getting it wrong
   * shifts every offset by six bytes, so the fixtures have to cover both.
   */
  exifPrefixed?: boolean;
  /** A chunk type this tool has no name for, to prove the allowlist drops it. */
  unknownChunk?: boolean;
  /** Emit the VP8X extended header. Forced on when any optional chunk is added. */
  extended?: boolean;
}

/**
 * A WebP carrying whichever chunks the test needs, with VP8X flags set to match
 * so the fixture is self-consistent before the strip runs.
 */
export async function makeWebp(options: WebpFixtureOptions = {}): Promise<Uint8Array> {
  const width = 32;
  const height = 24;
  const image = await encodedImageChunk(width, height);

  const optional: Uint8Array[] = [];
  let flags = 0;

  if (options.icc) {
    flags |= FLAG_ICC;
    optional.push(webpChunk('ICCP', latin1('fake-profile-body')));
  }
  if (options.exif) {
    flags |= FLAG_EXIF;
    // The JPEG builder always emits the `Exif\0\0` prefix; drop it unless this
    // fixture is deliberately exercising the prefixed form.
    const payload = buildExifPayload(options.exif);
    optional.push(webpChunk('EXIF', options.exifPrefixed ? payload : payload.subarray(6)));
  }
  if (options.xmp) {
    flags |= FLAG_XMP;
    optional.push(webpChunk('XMP ', latin1('<x:xmpmeta>creator: Jane</x:xmpmeta>')));
  }
  if (options.unknownChunk) {
    optional.push(webpChunk('vNDr', latin1('device-fingerprint-42')));
  }

  const parts: Uint8Array[] = [];
  if (options.extended || flags !== 0 || options.unknownChunk) {
    parts.push(webpChunk('VP8X', vp8xPayload(flags, width, height)));
  }
  // ICCP must precede the image data; EXIF and XMP follow it.
  const icc = options.icc ? optional.shift() : undefined;
  if (icc) parts.push(icc);
  parts.push(image);
  parts.push(...optional);

  const bodyLength = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(12 + bodyLength);
  out.set(fourcc('RIFF'), 0);
  out.set(fourcc('WEBP'), 8);
  // Counts from offset 8: the 'WEBP' FourCC plus every chunk after it.
  new DataView(out.buffer).setUint32(4, 4 + bodyLength, true);

  let at = 12;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The VP8X flags byte, or undefined when the file has no VP8X chunk. */
export function vp8xFlags(bytes: Uint8Array): number | undefined {
  let at = 12;
  while (at + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at + 4, true);
    if (type === 'VP8X') return bytes[at + 8];
    at += 8 + size + (size % 2);
  }
  return undefined;
}
