/**
 * ISOBMFF container surgery for MP4, MOV and M4V: walk the box tree, report what
 * is hiding, and blank the boxes that identify you.
 *
 * This format cannot be stripped the way the image formats are, and the reason
 * is worth stating plainly. A track's `stco`/`co64` tables hold **absolute file
 * offsets** into `mdat`. Delete any box that sits before the media data and
 * every one of those offsets is wrong, so the file still parses and no longer
 * plays. Rewriting them is possible but means understanding every table in
 * every track, including fragmented layouts.
 *
 * So nothing is deleted. A box being removed is overwritten in place with a
 * `free` box of exactly the same size: the standard "ignore these bytes" filler.
 * Every byte position in the file is unchanged, so no offset can break, and the
 * payload is genuinely gone rather than relocated. The cost is that the output
 * is the same length as the input, which is a surprising thing for a tool that
 * removes data to do, and is therefore surfaced as a note rather than left to be
 * noticed.
 *
 * Box layout per the QuickTime File Format:
 * https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChapter2/qtff2.html
 */
import type { Finding } from '../types';
import { ascii, MalformedFileError, u32be } from './bytes';
import type { StripNote, StripResult } from './types';

export interface Box {
  type: string;
  /** Offset of the 4-byte size field that introduces the box. */
  start: number;
  /** One past the box's last byte. */
  end: number;
  /** Offset of the box's contents, after size, type and any 64-bit size. */
  payloadAt: number;
}

/**
 * Boxes whose children we descend into when auditing.
 *
 * `udta` is on the list although it is also removed wholesale: the strip can
 * blank it without looking inside, but the audit has to look, or the GPS box it
 * holds is never named and the user is told only that "user data" is present.
 *
 * `meta` is deliberately *not* here. It is a full box, so its children start
 * four bytes after the payload rather than at it, and walking it as a plain
 * container would misread the first child. It is reported and blanked whole.
 */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta']);

/**
 * Boxes blanked wherever they appear.
 *
 * `udta` is where a phone writes GPS and device notes; `meta` holds iTunes-style
 * tag lists; `uuid` is the extension mechanism XMP arrives in. None is needed to
 * decode or play the file.
 */
const REMOVABLE = new Set(['udta', 'meta', 'uuid']);

/**
 * Padding boxes. Their contents are ignored by every player, which is exactly
 * what makes them a place to hide a payload, so they are zeroed rather than
 * trusted.
 */
const PADDING = new Set(['free', 'skip']);

/** Full boxes carrying creation and modification timestamps. */
const TIMESTAMPED = new Set(['mvhd', 'tkhd', 'mdhd']);

/** Apple's GPS box: 0xA9 then "xyz", holding an ISO 6709 location string. */
const GPS_BOX = '©xyz';

export function isIsobmff(bytes: Uint8Array): boolean {
  // The first box is `ftyp`, so its type sits at offset 4. Checking the type
  // rather than the size keeps this independent of how large that box is.
  return bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp';
}

/**
 * Walk one level of the box tree between `from` and `to`.
 *
 * @throws MalformedFileError on a size that cannot be trusted: too small to hold
 * its own header, or reaching past the end of the range.
 */
export function parseBoxes(bytes: Uint8Array, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let at = from;

  while (at + 8 <= to) {
    const size = u32be(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    let payloadAt = at + 8;
    let end: number;

    if (size === 1) {
      // 64-bit size. JavaScript numbers hold integers up to 2^53, far above any
      // real file, but the high word is read so a crafted value cannot wrap.
      const high = u32be(bytes, at + 8);
      const low = u32be(bytes, at + 12);
      if (high !== 0) throw new MalformedFileError(`box ${type} at ${at} is absurdly large`);
      end = at + low;
      payloadAt = at + 16;
    } else if (size === 0) {
      // Extends to the end of the range, which is only legal for the last box.
      end = to;
    } else {
      end = at + size;
    }

    if (end <= at || end > to) {
      throw new MalformedFileError(`box ${type} at ${at} has size ${size}, past the end`);
    }
    if (payloadAt > end)
      throw new MalformedFileError(`box ${type} at ${at} is shorter than its header`);

    boxes.push({ type, start: at, end, payloadAt });
    at = end;
  }

  return boxes;
}

/**
 * How deep the box tree may nest before we call the file hostile.
 *
 * A real file reaches about six (moov > trak > mdia > minf > stbl > stsd), so
 * this is generous. Without it, a crafted file of nested containers recurses
 * once per level and takes the tab down with a stack overflow, which is the one
 * outcome an adversarial-input path must never have.
 */
const MAX_DEPTH = 32;

/** Every box in the tree, depth first, paired with its depth. */
function walk(
  bytes: Uint8Array,
  from: number,
  to: number,
  depth = 0
): { box: Box; depth: number }[] {
  if (depth > MAX_DEPTH) {
    throw new MalformedFileError(`box tree nested deeper than ${MAX_DEPTH} levels`);
  }
  const out: { box: Box; depth: number }[] = [];
  for (const box of parseBoxes(bytes, from, to)) {
    out.push({ box, depth });
    if (CONTAINERS.has(box.type)) {
      out.push(...walk(bytes, box.payloadAt, box.end, depth + 1));
    }
  }
  return out;
}

/**
 * Read the creation and modification times from a timestamped full box.
 *
 * Both are seconds since 1904. Zero means "not set", which is what a stripped
 * file carries, so it is reported as absent rather than as a date in 1904.
 */
function readTimes(
  bytes: Uint8Array,
  box: Box
): { creation: number; modification: number; at: number; width: number } | undefined {
  // Full box: version byte, then 3 flag bytes, then the times.
  const version = bytes[box.payloadAt];
  if (version === undefined) return undefined;
  const at = box.payloadAt + 4;
  const width = version === 1 ? 8 : 4;
  if (at + width * 2 > box.end) return undefined;

  // A version-1 time is 64-bit; the high word of any real date is zero, and
  // reading only the low word keeps this in safe integer range.
  const read = (offset: number): number =>
    width === 8 ? u32be(bytes, offset + 4) : u32be(bytes, offset);

  return { creation: read(at), modification: read(at + width), at, width };
}

/** Does this box's payload hold anything other than zeros? */
function carriesData(bytes: Uint8Array, box: Box): boolean {
  for (let at = box.payloadAt; at < box.end; at += 1) {
    if (bytes[at] !== 0) return true;
  }
  return false;
}

/** Seconds since 1904-01-01 UTC, which is how ISOBMFF counts time. */
const EPOCH_OFFSET_SECONDS = 2_082_844_800;

function formatTime(seconds: number): string {
  return new Date((seconds - EPOCH_OFFSET_SECONDS) * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
}

/** Report everything identifying that this video is carrying. */
export function inspectIsobmff(bytes: Uint8Array): Finding[] {
  if (!isIsobmff(bytes)) throw new MalformedFileError('not an ISOBMFF file: no ftyp box');

  const findings: Finding[] = [];
  let reportedTime = false;

  for (const { box } of walk(bytes, 0, bytes.length)) {
    if (box.type === GPS_BOX) {
      // Payload is a 2-byte length, a 2-byte language code, then the location.
      const textAt = box.payloadAt + 4;
      const location = textAt < box.end ? ascii(bytes, textAt, box.end - textAt) : '';
      findings.push({
        id: `mp4-gps-${box.start}`,
        severity: 'high',
        category: 'gps',
        title: 'Location where this video was recorded',
        detail: location || 'an ISO 6709 coordinate',
      });
      continue;
    }

    if (REMOVABLE.has(box.type)) {
      findings.push({
        id: `mp4-${box.type}-${box.start}`,
        severity: 'medium',
        category: 'container',
        title:
          box.type === 'udta'
            ? 'User data'
            : box.type === 'meta'
              ? 'Metadata tags'
              : 'Extension box',
        detail: `${box.end - box.start} bytes holding device notes, tags or authoring data.`,
      });
      continue;
    }

    // Padding is only a finding when it actually holds something. Zeroed
    // padding carries nothing, and reporting it would mean this tool's own
    // output failed its own verify: a blanked box is a `free` box full of zeros.
    if (PADDING.has(box.type) && carriesData(bytes, box)) {
      findings.push({
        id: `mp4-padding-${box.start}`,
        severity: 'medium',
        category: 'container',
        title: 'Padding block with data in it',
        detail: `${box.end - box.payloadAt} bytes players ignore, which is what makes them somewhere to hide something. They will be zeroed.`,
      });
      continue;
    }

    // One timestamp finding, not one per track: a file has the same date on all
    // of them, and a list of identical dates is noise rather than information.
    if (!reportedTime && TIMESTAMPED.has(box.type)) {
      const times = readTimes(bytes, box);
      if (times && times.creation > 0) {
        findings.push({
          id: 'mp4-creation-time',
          severity: 'medium',
          category: 'metadata',
          title: 'When this video was recorded',
          detail: formatTime(times.creation),
        });
        reportedTime = true;
      }
    }
  }

  return findings;
}

/** The note explaining why the output is the same size as the input. */
export const SAME_SIZE_OUTPUT: Readonly<StripNote> = Object.freeze({
  id: 'blanked-in-place',
  title: 'Same file size',
  detail:
    'Video tracks record where their data sits by absolute position, so removing bytes would leave the file unplayable. The private parts were overwritten in place instead: they are gone, but the file stays the same length.',
});

/**
 * Blank the identifying boxes, leaving every byte position untouched.
 *
 * Each removed box becomes a `free` box of identical size with a zeroed payload,
 * so `stco`/`co64` offsets stay valid without being rewritten.
 */
export function stripIsobmff(bytes: Uint8Array): StripResult {
  if (!isIsobmff(bytes)) throw new MalformedFileError('not an ISOBMFF file: no ftyp box');

  const out = new Uint8Array(bytes);
  const notes: StripNote[] = [];
  let changed = false;

  const blank = (box: Box): void => {
    // Rewrite the header as `free`, keeping the original size, then zero the
    // payload. The box stays exactly as long as it was.
    out[box.start + 4] = 'f'.charCodeAt(0);
    out[box.start + 5] = 'r'.charCodeAt(0);
    out[box.start + 6] = 'e'.charCodeAt(0);
    out[box.start + 7] = 'e'.charCodeAt(0);
    out.fill(0, box.payloadAt, box.end);
    changed = true;
  };

  // The walk is built before any blanking, so it still lists the children of a
  // box we blank. Writing to one of those afterwards would put the `free` header
  // back into bytes we had just zeroed, leaving a padding box that looks like it
  // carries data and failing our own verify on a file that is actually clean.
  // Depth-first order means one watermark is enough to skip a blanked subtree.
  let blankedUntil = 0;

  for (const { box } of walk(bytes, 0, bytes.length)) {
    if (box.start < blankedUntil) continue;

    if (REMOVABLE.has(box.type)) {
      blank(box);
      blankedUntil = box.end;
      continue;
    }
    if (PADDING.has(box.type)) {
      // Already ignored by players, so only the payload needs clearing.
      if (box.end > box.payloadAt) {
        out.fill(0, box.payloadAt, box.end);
        changed = true;
      }
      continue;
    }
    if (TIMESTAMPED.has(box.type)) {
      const times = readTimes(bytes, box);
      if (times && (times.creation > 0 || times.modification > 0)) {
        out.fill(0, times.at, times.at + times.width * 2);
        changed = true;
      }
    }
  }

  if (changed) notes.push({ ...SAME_SIZE_OUTPUT });
  return { bytes: out, notes };
}
