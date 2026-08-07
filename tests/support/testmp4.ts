/**
 * ISOBMFF fixtures.
 *
 * Unlike the image fixtures, these cannot come from the browser: it has no MP4
 * encoder to borrow. They are assembled by hand instead, which is enough because
 * every assertion here is about the *container* - which boxes exist, where they
 * sit, and what survives a strip. Nothing decodes the media, and the losslessness
 * claim is checked by comparing the mdat bytes rather than by playing anything.
 */

function fourcc(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < 4; i += 1) out.push(text.charCodeAt(i) & 0xff);
  return out;
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** One box: 4-byte total size, 4-byte type, then the payload. */
export function box(type: string, payload: number[]): number[] {
  return [...u32(payload.length + 8), ...fourcc(type), ...payload];
}

/** A container box holding other boxes. */
function container(type: string, children: number[][]): number[] {
  return box(type, children.flat());
}

function ascii(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i) & 0xff);
  return out;
}

/** Seconds since 1904, which is how ISOBMFF counts time. */
export const EPOCH_OFFSET_SECONDS = 2_082_844_800;

/** A version-0 `mvhd` carrying creation and modification times. */
function mvhd(creation: number, modification: number): number[] {
  return box('mvhd', [
    0, // version 0
    0,
    0,
    0, // flags
    ...u32(creation),
    ...u32(modification),
    ...u32(1000), // timescale
    ...u32(5000), // duration
    // The rest of the box is matrix and rate fields the parser never reads.
    ...new Array<number>(80).fill(0),
  ]);
}

/** Apple's GPS box: 0xA9 then "xyz", holding an ISO 6709 string. */
function gpsBox(location: string): number[] {
  const text = ascii(location);
  // 2-byte length, 2-byte language, then the string.
  return box('©xyz', [0, text.length, 0, 0, ...text]);
}

export interface Mp4FixtureOptions {
  /** ISO 6709 location, written into a `©xyz` box inside `udta`. */
  gps?: string;
  /** Seconds since 1904 in the `mvhd` times. */
  creationTime?: number;
  /** Adds a `meta` box inside `moov`. */
  meta?: boolean;
  /** Adds a top-level `uuid` box, which is how XMP usually arrives. */
  uuid?: boolean;
  /** Adds a top-level `free` box carrying a payload. */
  paddingPayload?: string;
}

/** Recognisable bytes, so a test can assert the media survived untouched. */
export const MDAT_PAYLOAD = 'MEDIA-DATA-MUST-SURVIVE-UNTOUCHED';

/**
 * A structurally valid ISOBMFF file: ftyp, moov (with mvhd, a trak and optional
 * metadata), any requested padding, then mdat last.
 */
export function makeMp4(options: Mp4FixtureOptions = {}): Uint8Array {
  const ftyp = box('ftyp', [...fourcc('isom'), ...u32(512), ...fourcc('isom'), ...fourcc('mp41')]);

  const moovChildren: number[][] = [mvhd(options.creationTime ?? 0, options.creationTime ?? 0)];

  // A minimal trak, so the walk has a container to descend into.
  moovChildren.push(
    container('trak', [
      box('tkhd', [
        0,
        0,
        0,
        0,
        ...u32(options.creationTime ?? 0),
        ...u32(options.creationTime ?? 0),
        ...new Array<number>(76).fill(0),
      ]),
    ])
  );

  if (options.gps) moovChildren.push(container('udta', [gpsBox(options.gps)]));
  if (options.meta) moovChildren.push(box('meta', ascii('ilst-style tag data')));

  const parts: number[][] = [ftyp, container('moov', moovChildren)];
  if (options.uuid) parts.push(box('uuid', ascii('<x:xmpmeta>creator: Jane</x:xmpmeta>')));
  if (options.paddingPayload) parts.push(box('free', ascii(options.paddingPayload)));
  parts.push(box('mdat', ascii(MDAT_PAYLOAD)));

  return new Uint8Array(parts.flat());
}

/** The bytes of the first box of this type, for before/after comparison. */
export function boxBytes(bytes: Uint8Array, type: string): Uint8Array | undefined {
  let at = 0;
  while (at + 8 <= bytes.length) {
    const size =
      ((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0);
    const found = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (found === type) return bytes.subarray(at, at + size);
    if (size <= 0) return undefined;
    at += size;
  }
  return undefined;
}
