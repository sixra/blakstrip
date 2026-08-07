/**
 * PNG fixtures with planted metadata.
 *
 * Same approach as the JPEG fixtures: the base image comes from the browser's
 * own encoder so it is genuinely decodable, and chunks are spliced in after
 * IHDR, which is where a real writer puts them.
 */
import { buildExifPayload, type ExifOptions } from './testjpeg';

const SIGNATURE_LENGTH = 8;

/**
 * CRC-32 as PNG specifies it. Every chunk carries one, and a wrong CRC makes a
 * decoder reject the chunk, so a fixture that skipped this would be testing
 * against files no real reader would accept.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Assemble one chunk: length, type, data, CRC over type+data. */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** A tEXt chunk: NUL-separated keyword and value. */
function textChunk(keyword: string, value: string): Uint8Array {
  return pngChunk('tEXt', latin1(`${keyword}\0${value}`));
}

/** A real, decodable PNG from the browser's encoder. */
export async function basePng(width = 32, height = 24): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#004225');
  gradient.addColorStop(1, '#ffd700');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('toBlob returned null');
  return new Uint8Array(await blob.arrayBuffer());
}

export interface PngFixtureOptions {
  /** tEXt chunks as keyword/value pairs. */
  text?: Record<string, string>;
  /** An eXIf chunk carrying raw TIFF (no `Exif\0\0` prefix, unlike JPEG). */
  exif?: ExifOptions;
  /** A tIME chunk recording a last-modified date. */
  time?: boolean;
  /** A colour chunk, to prove it survives the default strip. */
  gamma?: boolean;
  /** A chunk type this tool has no name for, to prove the allowlist drops it. */
  unknownChunk?: boolean;
}

/**
 * A decodable PNG carrying whichever chunks the test needs, spliced in right
 * after IHDR (which must stay first).
 */
export async function makePng(options: PngFixtureOptions = {}): Promise<Uint8Array> {
  const base = await basePng();
  const inserts: Uint8Array[] = [];

  for (const [keyword, value] of Object.entries(options.text ?? {})) {
    inserts.push(textChunk(keyword, value));
  }
  if (options.exif) {
    // Strip the `Exif\0\0` prefix the JPEG builder adds: PNG stores raw TIFF.
    const withPrefix = buildExifPayload(options.exif);
    inserts.push(pngChunk('eXIf', withPrefix.subarray(6)));
  }
  if (options.time) {
    // year, month, day, hour, minute, second
    inserts.push(pngChunk('tIME', new Uint8Array([0x07, 0xea, 3, 14, 9, 26, 53])));
  }
  if (options.gamma) {
    inserts.push(pngChunk('gAMA', new Uint8Array([0x00, 0x00, 0xb1, 0x8f])));
  }
  if (options.unknownChunk) {
    inserts.push(pngChunk('vNDr', latin1('device-fingerprint-42')));
  }

  // IHDR is always the first chunk and is always 25 bytes (13 data + 12).
  const afterIhdr = SIGNATURE_LENGTH + 25;
  let total = base.length;
  for (const insert of inserts) total += insert.length;

  const out = new Uint8Array(total);
  out.set(base.subarray(0, afterIhdr), 0);
  let at = afterIhdr;
  for (const insert of inserts) {
    out.set(insert, at);
    at += insert.length;
  }
  out.set(base.subarray(afterIhdr), at);
  return out;
}
