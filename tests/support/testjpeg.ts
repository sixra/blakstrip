/**
 * JPEG fixtures with planted metadata.
 *
 * The base image is produced by the browser's own encoder, so it is a genuinely
 * decodable JPEG rather than a hand-assembled imitation. Metadata segments are
 * then spliced in right after SOI, which is exactly where a camera puts them.
 * That makes the "we removed it" assertions meaningful: the thing being removed
 * is in the same place, and the same shape, as in a real photo.
 */

/**
 * A TIFF/EXIF writer, only as complete as the fixtures need.
 *
 * Byte order is a constructor argument because real cameras use both, and a
 * parser that only ever sees one of them has half its reader untested. Canon and
 * Nikon write `MM`, most phones write `II`.
 */
class ExifWriter {
  private readonly bytes: number[] = [];

  constructor(private readonly littleEndian = false) {}

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }
  u16(value: number): void {
    const be = [(value >> 8) & 0xff, value & 0xff];
    this.bytes.push(...(this.littleEndian ? be.reverse() : be));
  }
  u32(value: number): void {
    const be = [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
    this.bytes.push(...(this.littleEndian ? be.reverse() : be));
  }
  toArray(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

export interface ExifOptions {
  orientation?: number;
  make?: string;
  model?: string;
  software?: string;
  dateTime?: string;
  /** Decimal degrees; written as the usual degrees/minutes/seconds rationals. */
  gps?: { lat: number; lon: number };
  /** Adds an IFD1 describing a thumbnail of this many bytes. */
  thumbnailBytes?: number;
  /**
   * Width of the thumbnail-length tag. The spec says LONG, but writers differ,
   * and a reader that assumes LONG picks up the two bytes after a SHORT.
   */
  thumbnailLengthType?: 'short' | 'long';
  /**
   * TIFF byte order. `MM` (big-endian) by default because that is what the
   * original fixtures used; `II` exercises the other half of `readerFor`.
   */
  byteOrder?: 'II' | 'MM';
  /**
   * The Exif sub-IFD, which IFD0 points at through tag 0x8769. This is where a
   * camera puts most of what identifies it, and none of it is reachable from
   * IFD0 alone.
   */
  subIfd?: {
    makerNote?: boolean;
    dateTimeOriginal?: string;
    bodySerial?: string;
    lensSerial?: string;
  };
}

const TAG = {
  orientation: 0x0112,
  make: 0x010f,
  model: 0x0110,
  software: 0x0131,
  dateTime: 0x0132,
  gpsIfd: 0x8825,
  thumbOffset: 0x0201,
  thumbLength: 0x0202,
  exifIfd: 0x8769,
  makerNote: 0x927c,
  dateTimeOriginal: 0x9003,
  bodySerial: 0xa431,
  lensSerial: 0xa435,
} as const;

const TYPE = { ascii: 2, short: 3, long: 4, rational: 5, undefinedType: 7 } as const;

interface PendingEntry {
  tag: number;
  type: number;
  count: number;
  /** Written inline when it fits in 4 bytes, otherwise appended and pointed at. */
  inline?: number;
  data?: number[];
}

function dmsRationals(value: number): number[] {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  // Seconds carry two decimals, which is well inside what the audit displays.
  const sec = Math.round((minFloat - min) * 60 * 100);
  return [deg, 1, min, 1, sec, 100];
}

/**
 * Bytes this entry appends after the IFD. EXIF requires a value of 4 bytes or
 * fewer to sit *inside* the entry's value field rather than behind a pointer, so
 * only larger values contribute trailing data. Getting this wrong produces a
 * file real readers misparse, which is exactly what a fixture must not do.
 */
function trailingLength(entry: PendingEntry): number {
  const length = entry.data?.length ?? 0;
  return length > 4 ? length : 0;
}

/** Serialize one IFD plus its out-of-line data. Offsets are TIFF-relative. */
function writeIfd(
  w: ExifWriter,
  entries: PendingEntry[],
  ifdAt: number,
  nextIfdOffset: number
): void {
  w.u16(entries.length);
  const dataAt = ifdAt + 2 + entries.length * 12 + 4;
  let cursor = dataAt;
  const trailing: number[] = [];

  for (const entry of entries) {
    w.u16(entry.tag);
    w.u16(entry.type);
    w.u32(entry.count);
    if (entry.data && entry.data.length <= 4) {
      // Inline, left-aligned and zero-padded to the full 4-byte field.
      for (let i = 0; i < 4; i += 1) w.u8(entry.data[i] ?? 0);
    } else if (entry.data) {
      w.u32(cursor);
      trailing.push(...entry.data);
      cursor += entry.data.length;
    } else {
      // A SHORT sits in the first two bytes of the value field; a LONG fills it.
      if (entry.type === TYPE.short) {
        w.u16(entry.inline ?? 0);
        w.u16(0);
      } else {
        w.u32(entry.inline ?? 0);
      }
    }
  }
  w.u32(nextIfdOffset);
  for (const byte of trailing) w.u8(byte);
}

/** A 32-bit value as raw bytes in the file's declared order. */
function u32Bytes(value: number, littleEndian: boolean): number[] {
  const be = [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  return littleEndian ? be.reverse() : be;
}

function asciiBytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i) & 0xff);
  out.push(0);
  return out;
}

/** Build a complete `Exif\0\0` + TIFF payload for a JPEG APP1 segment. */
export function buildExifPayload(options: ExifOptions): Uint8Array {
  const littleEndian = options.byteOrder === 'II';
  const w = new ExifWriter(littleEndian);
  for (const ch of 'Exif') w.u8(ch.charCodeAt(0));
  w.u8(0);
  w.u8(0);

  // TIFF header: byte-order mark, magic 42, IFD0 immediately after.
  w.u8(littleEndian ? 0x49 : 0x4d);
  w.u8(littleEndian ? 0x49 : 0x4d);
  w.u16(0x2a);
  w.u32(8);

  const ifd0: PendingEntry[] = [];
  if (options.orientation !== undefined) {
    ifd0.push({ tag: TAG.orientation, type: TYPE.short, count: 1, inline: options.orientation });
  }
  for (const [tag, value] of [
    [TAG.make, options.make],
    [TAG.model, options.model],
    [TAG.software, options.software],
    [TAG.dateTime, options.dateTime],
  ] as const) {
    if (value === undefined) continue;
    const data = asciiBytes(value);
    ifd0.push({ tag, type: TYPE.ascii, count: data.length, data });
  }

  // The GPS IFD is written after IFD0 (and after IFD1 when there is one), so its
  // offset is only known once those are sized. Two passes would be tidier; a
  // fixed layout is simpler and this is a fixture builder.
  const gpsPlaceholderIndex = options.gps ? ifd0.length : -1;
  if (options.gps) ifd0.push({ tag: TAG.gpsIfd, type: TYPE.long, count: 1, inline: 0 });

  const exifEntries: PendingEntry[] = [];
  if (options.subIfd) {
    const { makerNote, dateTimeOriginal, bodySerial, lensSerial } = options.subIfd;
    if (makerNote) {
      // Contents are opaque to the audit, which only reports that one is present:
      // a MakerNote is a vendor blob with no public schema.
      exifEntries.push({
        tag: TAG.makerNote,
        type: TYPE.undefinedType,
        count: 6,
        data: [1, 2, 3, 4, 5, 6],
      });
    }
    for (const [tag, value] of [
      [TAG.dateTimeOriginal, dateTimeOriginal],
      [TAG.bodySerial, bodySerial],
      [TAG.lensSerial, lensSerial],
    ] as const) {
      if (value === undefined) continue;
      const data = asciiBytes(value);
      exifEntries.push({ tag, type: TYPE.ascii, count: data.length, data });
    }
  }
  const gpsEntries: PendingEntry[] = [];
  if (options.gps) {
    const { lat, lon } = options.gps;
    const rational = (value: number): number[] =>
      dmsRationals(value).flatMap((n) => u32Bytes(n, littleEndian));
    gpsEntries.push(
      { tag: 0x0001, type: TYPE.ascii, count: 2, data: asciiBytes(lat < 0 ? 'S' : 'N') },
      { tag: 0x0002, type: TYPE.rational, count: 3, data: rational(lat) },
      { tag: 0x0003, type: TYPE.ascii, count: 2, data: asciiBytes(lon < 0 ? 'W' : 'E') },
      { tag: 0x0004, type: TYPE.rational, count: 3, data: rational(lon) }
    );
  }

  const exifPlaceholderIndex = exifEntries.length > 0 ? ifd0.length : -1;
  if (exifEntries.length > 0) {
    ifd0.push({ tag: TAG.exifIfd, type: TYPE.long, count: 1, inline: 0 });
  }

  const ifd0At = 8;
  const ifd0Size =
    2 + ifd0.length * 12 + 4 + ifd0.reduce((sum, entry) => sum + trailingLength(entry), 0);

  const ifd1: PendingEntry[] = [];
  if (options.thumbnailBytes !== undefined) {
    ifd1.push({ tag: TAG.thumbOffset, type: TYPE.long, count: 1, inline: 0 });
    ifd1.push({
      tag: TAG.thumbLength,
      type: options.thumbnailLengthType === 'short' ? TYPE.short : TYPE.long,
      count: 1,
      inline: options.thumbnailBytes,
    });
  }
  const ifd1At = ifd1.length > 0 ? ifd0At + ifd0Size : 0;
  const ifd1Size = ifd1.length > 0 ? 2 + ifd1.length * 12 + 4 : 0;

  const gpsAt = ifd0At + ifd0Size + ifd1Size;
  if (gpsPlaceholderIndex >= 0) {
    const entry = ifd0[gpsPlaceholderIndex];
    if (entry) entry.inline = gpsAt;
  }

  // The sub-IFD goes last, so its offset needs the GPS block's size first. Sized
  // from the entries themselves with the same helper IFD0 uses: a hardcoded count
  // here was wrong the moment it was written.
  const gpsSize =
    gpsEntries.length > 0
      ? 2 +
        gpsEntries.length * 12 +
        4 +
        gpsEntries.reduce((sum, entry) => sum + trailingLength(entry), 0)
      : 0;
  const exifAt = gpsAt + gpsSize;
  if (exifPlaceholderIndex >= 0) {
    const entry = ifd0[exifPlaceholderIndex];
    if (entry) entry.inline = exifAt;
  }

  writeIfd(w, ifd0, ifd0At, ifd1At);
  if (ifd1.length > 0) writeIfd(w, ifd1, ifd1At, 0);

  if (gpsEntries.length > 0) writeIfd(w, gpsEntries, gpsAt, 0);
  if (exifEntries.length > 0) writeIfd(w, exifEntries, exifAt, 0);

  return w.toArray();
}

/** Wrap a payload in a JPEG APP segment header (marker + 2-byte length). */
export function appSegment(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 4);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = ((payload.length + 2) >> 8) & 0xff;
  out[3] = (payload.length + 2) & 0xff;
  out.set(payload, 4);
  return out;
}

function textPayload(prefix: string, body: string): Uint8Array {
  const text = `${prefix}${body}`;
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** A real, decodable JPEG from the browser's encoder. */
export async function baseJpeg(width = 32, height = 24): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  // A gradient plus a shape: flat colour compresses to almost nothing, which
  // would make "the scan data is unchanged" a weaker assertion than it looks.
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#8b0000');
  gradient.addColorStop(1, '#00308f');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#f5f5dc';
  ctx.fillRect(width / 4, height / 4, width / 2, height / 2);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.9)
  );
  if (!blob) throw new Error('toBlob returned null');
  return new Uint8Array(await blob.arrayBuffer());
}

export interface JpegFixtureOptions {
  exif?: ExifOptions;
  xmp?: boolean;
  iptc?: boolean;
  comment?: string;
  icc?: boolean;
  /** An APP segment this tool has no name for, to prove the allowlist drops it. */
  unknownApp?: boolean;
}

/**
 * A decodable JPEG carrying whichever metadata segments the test needs,
 * inserted directly after SOI.
 */
export async function makeJpeg(options: JpegFixtureOptions = {}): Promise<Uint8Array> {
  const base = await baseJpeg();
  const inserts: Uint8Array[] = [];

  if (options.exif) inserts.push(appSegment(0xe1, buildExifPayload(options.exif)));
  if (options.xmp) {
    inserts.push(
      appSegment(
        0xe1,
        textPayload('http://ns.adobe.com/xap/1.0/\0', '<x:xmpmeta>creator: Jane</x:xmpmeta>')
      )
    );
  }
  if (options.iptc) {
    inserts.push(appSegment(0xed, textPayload('Photoshop 3.0\0', '8BIM caption: private note')));
  }
  if (options.icc) {
    // Only the prefix matters to the classifier; the profile body is opaque here.
    inserts.push(appSegment(0xe2, textPayload('ICC_PROFILE\0', ' fake-profile-body')));
  }
  if (options.comment !== undefined) {
    inserts.push(appSegment(0xfe, textPayload('', options.comment)));
  }
  if (options.unknownApp) {
    inserts.push(appSegment(0xe7, textPayload('VendorSecret\0', 'device-fingerprint-42')));
  }

  let total = base.length;
  for (const insert of inserts) total += insert.length;
  const out = new Uint8Array(total);
  out.set(base.subarray(0, 2), 0); // SOI
  let at = 2;
  for (const insert of inserts) {
    out.set(insert, at);
    at += insert.length;
  }
  out.set(base.subarray(2), at);
  return out;
}
