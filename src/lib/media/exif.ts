/**
 * Reading EXIF for the audit: what is hiding in this photo, in words a person
 * can act on. This is a *reader*, never a writer of the original: stripping is
 * done by dropping whole container segments, not by editing TIFF in place.
 *
 * The one thing built here is a minimal orientation block (see
 * `buildOrientationExif`), because dropping EXIF wholesale from a photo that
 * relied on the Orientation tag would silently rotate it.
 */
import type { Finding } from '../types';
import { ascii, MalformedFileError, matches, u16be, u16le, u32be, u32le } from './bytes';

/** The `Exif\0\0` prefix that introduces EXIF inside a JPEG APP1 segment. */
export const EXIF_PREFIX = 'Exif\0\0';

const TAG_ORIENTATION = 0x0112;
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_SOFTWARE = 0x0131;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_MAKERNOTE = 0x927c;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_BODY_SERIAL = 0xa431;
const TAG_LENS_SERIAL = 0xa435;
const TAG_THUMB_OFFSET = 0x0201;
const TAG_THUMB_LENGTH = 0x0202;

const GPS_LAT_REF = 0x0001;
const GPS_LAT = 0x0002;
const GPS_LON_REF = 0x0003;
const GPS_LON = 0x0004;

/** Byte width of each TIFF field type, indexed by the type code. 0 = unknown. */
const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

interface Reader {
  u16: (at: number) => number;
  u32: (at: number) => number;
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Offset of the 4-byte value field itself, not what it points at. */
  valueAt: number;
}

/**
 * The parsed shape of one EXIF block: just enough to describe it and to know
 * whether an orientation needs preserving.
 */
export interface ExifSummary {
  orientation: number | undefined;
  gps: { lat: number; lon: number } | undefined;
  make: string | undefined;
  model: string | undefined;
  software: string | undefined;
  /** Any capture or modification timestamp found, first one wins. */
  timestamp: string | undefined;
  serials: string[];
  hasMakerNote: boolean;
  /** Byte length of an embedded thumbnail, when IFD1 carries one. */
  thumbnailBytes: number | undefined;
}

function readerFor(bytes: Uint8Array, tiffAt: number): Reader {
  if (matches(bytes, tiffAt, 'II')) {
    return { u16: (at) => u16le(bytes, at), u32: (at) => u32le(bytes, at) };
  }
  if (matches(bytes, tiffAt, 'MM')) {
    return { u16: (at) => u16be(bytes, at), u32: (at) => u32be(bytes, at) };
  }
  throw new MalformedFileError('EXIF: TIFF header is neither II nor MM');
}

function readEntries(ifdAt: number, r: Reader): Entry[] {
  const count = r.u16(ifdAt);
  const out: Entry[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = ifdAt + 2 + i * 12;
    // The entry count is attacker-controlled, so this walk can run off the end.
    // The readers bounds-check every access and throw, which is the intended
    // outcome: a malformed directory is a malformed file.
    out.push({ tag: r.u16(at), type: r.u16(at + 2), count: r.u32(at + 4), valueAt: at + 8 });
  }
  return out;
}

/** Where an entry's data actually lives: inline when it fits in 4 bytes, else via a pointer. */
function dataAt(entry: Entry, tiffAt: number, r: Reader): number {
  const size = (TYPE_SIZES[entry.type] ?? 0) * entry.count;
  return size <= 4 ? entry.valueAt : tiffAt + r.u32(entry.valueAt);
}

function readAscii(bytes: Uint8Array, entry: Entry, tiffAt: number, r: Reader): string {
  if (entry.type !== 2) return '';
  return ascii(bytes, dataAt(entry, tiffAt, r), entry.count).trim();
}

/** RATIONAL triple (degrees, minutes, seconds) as used by the GPS IFD. */
function readDegrees(entry: Entry, tiffAt: number, r: Reader): number {
  if (entry.type !== 5 || entry.count < 3) throw new MalformedFileError('EXIF: bad GPS rational');
  const at = dataAt(entry, tiffAt, r);
  let deg = 0;
  for (let i = 0; i < 3; i += 1) {
    const num = r.u32(at + i * 8);
    const den = r.u32(at + i * 8 + 4);
    // A zero denominator is malformed; treating it as zero keeps the parse
    // going so the rest of the audit still reports, which matters more than
    // failing the whole file over one field.
    const value = den === 0 ? 0 : num / den;
    deg += value / 60 ** i;
  }
  return deg;
}

function findEntry(entries: Entry[], tag: number): Entry | undefined {
  return entries.find((e) => e.tag === tag);
}

/**
 * Summarize an EXIF block. `bytes` is the whole file; `tiffAt` points at the
 * TIFF header (the `II`/`MM`), which is where all internal offsets are relative
 * to.
 */
export function summarizeExif(bytes: Uint8Array, tiffAt: number): ExifSummary {
  const r = readerFor(bytes, tiffAt);
  const magic = r.u16(tiffAt + 2);
  if (magic !== 0x2a) throw new MalformedFileError(`EXIF: bad TIFF magic ${magic}`);

  const ifd0At = tiffAt + r.u32(tiffAt + 4);
  const ifd0 = readEntries(ifd0At, r);

  const summary: ExifSummary = {
    orientation: undefined,
    gps: undefined,
    make: undefined,
    model: undefined,
    software: undefined,
    timestamp: undefined,
    serials: [],
    hasMakerNote: false,
    thumbnailBytes: undefined,
  };

  const orientation = findEntry(ifd0, TAG_ORIENTATION);
  if (orientation && orientation.type === 3) summary.orientation = r.u16(orientation.valueAt);

  const make = findEntry(ifd0, TAG_MAKE);
  if (make) summary.make = readAscii(bytes, make, tiffAt, r) || undefined;
  const model = findEntry(ifd0, TAG_MODEL);
  if (model) summary.model = readAscii(bytes, model, tiffAt, r) || undefined;
  const software = findEntry(ifd0, TAG_SOFTWARE);
  if (software) summary.software = readAscii(bytes, software, tiffAt, r) || undefined;
  const dateTime = findEntry(ifd0, TAG_DATETIME);
  if (dateTime) summary.timestamp = readAscii(bytes, dateTime, tiffAt, r) || undefined;

  const exifPtr = findEntry(ifd0, TAG_EXIF_IFD);
  if (exifPtr) {
    const exif = readEntries(tiffAt + r.u32(exifPtr.valueAt), r);
    summary.hasMakerNote = Boolean(findEntry(exif, TAG_MAKERNOTE));
    const original = findEntry(exif, TAG_DATETIME_ORIGINAL);
    if (original) summary.timestamp ??= readAscii(bytes, original, tiffAt, r) || undefined;
    for (const tag of [TAG_BODY_SERIAL, TAG_LENS_SERIAL]) {
      const entry = findEntry(exif, tag);
      const value = entry ? readAscii(bytes, entry, tiffAt, r) : '';
      if (value) summary.serials.push(value);
    }
  }

  const gpsPtr = findEntry(ifd0, TAG_GPS_IFD);
  if (gpsPtr) {
    const gps = readEntries(tiffAt + r.u32(gpsPtr.valueAt), r);
    const lat = findEntry(gps, GPS_LAT);
    const lon = findEntry(gps, GPS_LON);
    if (lat && lon) {
      const latRef = findEntry(gps, GPS_LAT_REF);
      const lonRef = findEntry(gps, GPS_LON_REF);
      const south = latRef ? readAscii(bytes, latRef, tiffAt, r).toUpperCase() === 'S' : false;
      const west = lonRef ? readAscii(bytes, lonRef, tiffAt, r).toUpperCase() === 'W' : false;
      summary.gps = {
        lat: readDegrees(lat, tiffAt, r) * (south ? -1 : 1),
        lon: readDegrees(lon, tiffAt, r) * (west ? -1 : 1),
      };
    }
  }

  // IFD1, when present, is the thumbnail directory. A thumbnail is worth calling
  // out on its own: it is generated at capture, so on a cropped or edited photo
  // it can still show the original frame.
  const nextIfdAt = ifd0At + 2 + ifd0.length * 12;
  const ifd1Offset = r.u32(nextIfdAt);
  if (ifd1Offset !== 0) {
    const ifd1 = readEntries(tiffAt + ifd1Offset, r);
    const length = findEntry(ifd1, TAG_THUMB_LENGTH);
    const offset = findEntry(ifd1, TAG_THUMB_OFFSET);
    if (length && offset) summary.thumbnailBytes = r.u32(length.valueAt);
  }

  return summary;
}

/** Round to 5 decimal places: ~1 m, enough to show the leak without false precision. */
function coord(value: number): string {
  return value.toFixed(5);
}

/** Turn an EXIF summary into the findings the audit shows. */
export function exifFindings(summary: ExifSummary): Finding[] {
  const findings: Finding[] = [];

  if (summary.gps) {
    findings.push({
      id: 'exif-gps',
      severity: 'high',
      category: 'gps',
      title: 'Location where this photo was taken',
      detail: `${coord(summary.gps.lat)}, ${coord(summary.gps.lon)}`,
    });
  }

  if (summary.thumbnailBytes !== undefined) {
    findings.push({
      id: 'exif-thumbnail',
      severity: 'high',
      category: 'thumbnail',
      title: 'Embedded preview image',
      detail: `${summary.thumbnailBytes} bytes. Written when the photo was taken, so on an edited or cropped photo it can still show the original.`,
    });
  }

  const device = [summary.make, summary.model].filter(Boolean).join(' ');
  if (device) {
    findings.push({
      id: 'exif-device',
      severity: 'medium',
      category: 'exif',
      title: 'Camera or phone used',
      detail: device,
    });
  }

  if (summary.serials.length > 0) {
    findings.push({
      id: 'exif-serial',
      severity: 'high',
      category: 'exif',
      title: 'Camera serial number',
      detail: `${summary.serials.join(', ')}. Ties every photo from this device together.`,
    });
  }

  if (summary.timestamp) {
    findings.push({
      id: 'exif-timestamp',
      severity: 'medium',
      category: 'exif',
      title: 'When this photo was taken',
      detail: summary.timestamp,
    });
  }

  if (summary.software) {
    findings.push({
      id: 'exif-software',
      severity: 'medium',
      category: 'exif',
      title: 'Software that last wrote this file',
      detail: summary.software,
    });
  }

  if (summary.hasMakerNote) {
    findings.push({
      id: 'exif-makernote',
      severity: 'medium',
      category: 'makernote',
      title: 'Manufacturer data block',
      detail:
        'An undocumented, vendor-specific block. Its contents vary by camera and can include focus, lens and serial details.',
    });
  }

  return findings;
}

/**
 * A complete EXIF APP1 payload carrying nothing but Orientation.
 *
 * Dropping EXIF from a photo whose pixels are stored rotated makes it display
 * sideways, because the tag was doing the rotating. Rotating the pixels instead
 * would mean re-encoding, which the lossless path exists to avoid, so the one
 * tag is kept. It carries no location, device or time.
 */
export function buildOrientationExif(orientation: number): Uint8Array {
  // Exif\0\0 | TIFF header (8) | IFD0 count (2) | one 12-byte entry | next-IFD (4)
  const out = new Uint8Array(6 + 8 + 2 + 12 + 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < EXIF_PREFIX.length; i += 1) out[i] = EXIF_PREFIX.charCodeAt(i);

  const tiff = 6;
  out[tiff] = 0x4d; // 'M'
  out[tiff + 1] = 0x4d; // 'M', big-endian, matching the writes below
  view.setUint16(tiff + 2, 0x2a);
  view.setUint32(tiff + 4, 8); // IFD0 sits immediately after the header

  const ifd = tiff + 8;
  view.setUint16(ifd, 1); // one entry
  view.setUint16(ifd + 2, TAG_ORIENTATION);
  view.setUint16(ifd + 4, 3); // SHORT
  view.setUint32(ifd + 6, 1); // count
  // A SHORT occupies the first 2 of the value field's 4 bytes; the rest stays 0.
  view.setUint16(ifd + 10, orientation);
  view.setUint32(ifd + 14, 0); // no IFD1, so no thumbnail

  return out;
}
