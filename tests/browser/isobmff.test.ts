import { describe, expect, it } from 'vitest';
import { MalformedFileError } from '../../src/lib/media/bytes';
import { inspectIsobmff, isIsobmff, parseBoxes, stripIsobmff } from '../../src/lib/media/isobmff';
import { box, boxBytes, EPOCH_OFFSET_SECONDS, makeMp4, MDAT_PAYLOAD } from '../support/testmp4';

function findingIds(bytes: Uint8Array): string[] {
  return inspectIsobmff(bytes).map((f) => f.id);
}

function topLevelTypes(bytes: Uint8Array): string[] {
  return parseBoxes(bytes, 0, bytes.length).map((b) => b.type);
}

/** 2026-03-14 09:26:53 UTC, expressed the way ISOBMFF counts. */
const RECORDED_AT = Math.floor(Date.UTC(2026, 2, 14, 9, 26, 53) / 1000) + EPOCH_OFFSET_SECONDS;

describe('isobmff audit', () => {
  it('finds every planted leak vector', () => {
    const bytes = makeMp4({
      gps: '+44.8125+020.4612/',
      creationTime: RECORDED_AT,
      meta: true,
      uuid: true,
      paddingPayload: 'hidden-in-padding',
    });

    const ids = findingIds(bytes);
    expect(ids.some((id) => id.startsWith('mp4-gps-'))).toBe(true);
    expect(ids).toContain('mp4-creation-time');
    expect(ids.some((id) => id.startsWith('mp4-meta-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('mp4-uuid-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('mp4-padding-'))).toBe(true);
  });

  it('reports the recorded location as coordinates a person can recognise', () => {
    const bytes = makeMp4({ gps: '+44.8125+020.4612/' });
    const gps = inspectIsobmff(bytes).find((f) => f.id.startsWith('mp4-gps-'));
    expect(gps?.severity).toBe('high');
    expect(gps?.detail).toContain('+44.8125+020.4612');
  });

  it('reports the recording date, read from the 1904 epoch', () => {
    const bytes = makeMp4({ creationTime: RECORDED_AT });
    const time = inspectIsobmff(bytes).find((f) => f.id === 'mp4-creation-time');
    // Getting the epoch wrong is a 66-year error, so the year is the assertion
    // that matters.
    expect(time?.detail).toContain('2026-03-14');
  });

  it('reports one date rather than one per track', () => {
    // The fixture stamps mvhd and tkhd alike, as a real file does. A finding per
    // track would be a list of identical dates: noise, not information.
    const bytes = makeMp4({ creationTime: RECORDED_AT });
    expect(findingIds(bytes).filter((id) => id === 'mp4-creation-time')).toHaveLength(1);
  });

  it('finds nothing in a file that carries nothing', () => {
    expect(findingIds(makeMp4())).toEqual([]);
  });

  it('gives every finding a distinct id', () => {
    const bytes = makeMp4({
      gps: '+1+2/',
      creationTime: RECORDED_AT,
      meta: true,
      uuid: true,
      paddingPayload: 'x',
    });
    const ids = findingIds(bytes);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('isobmff strip', () => {
  it('removes every identifying box and verifies clean', () => {
    const bytes = makeMp4({
      gps: '+44.8125+020.4612/',
      creationTime: RECORDED_AT,
      meta: true,
      uuid: true,
      paddingPayload: 'hidden-in-padding',
    });
    expect(findingIds(bytes).length).toBeGreaterThan(0);

    const { bytes: stripped } = stripIsobmff(bytes);
    expect(inspectIsobmff(stripped)).toEqual([]);
  });

  it('leaves the media data byte-identical', () => {
    const bytes = makeMp4({ gps: '+1+2/', creationTime: RECORDED_AT, uuid: true });
    const { bytes: stripped } = stripIsobmff(bytes);

    // The whole point: the picture is untouched, only the container is edited.
    expect(boxBytes(stripped, 'mdat')).toEqual(boxBytes(bytes, 'mdat'));
    expect(new TextDecoder().decode(stripped)).toContain(MDAT_PAYLOAD);
  });

  it('keeps every byte position, because chunk offsets are absolute', () => {
    // A track records where its data sits by absolute file offset. Shortening
    // anything ahead of mdat leaves a file that parses and will not play, so the
    // output must be exactly as long as the input and mdat must not move.
    const bytes = makeMp4({ gps: '+1+2/', creationTime: RECORDED_AT, meta: true, uuid: true });
    const { bytes: stripped } = stripIsobmff(bytes);

    expect(stripped.length).toBe(bytes.length);

    const mdatAt = (buf: Uint8Array): number =>
      parseBoxes(buf, 0, buf.length).find((b) => b.type === 'mdat')?.start ?? -1;
    expect(mdatAt(stripped)).toBe(mdatAt(bytes));
    expect(mdatAt(stripped)).toBeGreaterThan(0);
  });

  it('says why the file did not get smaller', () => {
    // A tool that removes data and returns a file of identical size owes the
    // user an explanation, or it looks like it did nothing.
    const bytes = makeMp4({ gps: '+1+2/' });
    expect(stripIsobmff(bytes).notes.map((n) => n.id)).toEqual(['blanked-in-place']);
  });

  it('makes no note when there was nothing to remove', () => {
    expect(stripIsobmff(makeMp4()).notes).toEqual([]);
  });

  it('turns a removed box into free padding rather than deleting it', () => {
    const bytes = makeMp4({ uuid: true });
    expect(topLevelTypes(bytes)).toContain('uuid');

    const { bytes: stripped } = stripIsobmff(bytes);
    expect(topLevelTypes(stripped)).not.toContain('uuid');
    expect(topLevelTypes(stripped)).toContain('free');
  });

  it('zeroes the payload of a removed box, not just its type', () => {
    // Renaming a box to `free` while leaving its bytes would hide the data from
    // this tool's own audit while leaving it perfectly readable in a hex editor.
    const bytes = makeMp4({ uuid: true });
    const { bytes: stripped } = stripIsobmff(bytes);
    expect(new TextDecoder().decode(stripped)).not.toContain('creator: Jane');
  });

  it('zeroes a padding box that was carrying a payload', () => {
    const bytes = makeMp4({ paddingPayload: 'hidden-in-padding' });
    const { bytes: stripped } = stripIsobmff(bytes);
    expect(new TextDecoder().decode(stripped)).not.toContain('hidden-in-padding');
    // Still a `free` box of the same size, so nothing downstream moved.
    expect(topLevelTypes(stripped)).toEqual(topLevelTypes(bytes));
  });

  it('is idempotent: stripping a stripped file changes nothing', () => {
    const bytes = makeMp4({ gps: '+1+2/', creationTime: RECORDED_AT, uuid: true });
    const once = stripIsobmff(bytes).bytes;
    expect(stripIsobmff(once).bytes).toEqual(once);
  });
});

describe('isobmff parser hostility', () => {
  it('rejects a file with no ftyp box', () => {
    expect(isIsobmff(new Uint8Array(16))).toBe(false);
    expect(() => inspectIsobmff(new Uint8Array(16))).toThrow(MalformedFileError);
  });

  it('rejects a box size that reaches past the end', () => {
    const bytes = new Uint8Array([...box('ftyp', [0, 0, 0, 0])]);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x0000ffff);
    expect(() => parseBoxes(bytes, 0, bytes.length)).toThrow(MalformedFileError);
  });

  it('rejects a box too small to hold its own header', () => {
    // Size 4 does not even cover the size and type fields, so a parser that
    // trusted it would advance by less than one header and never terminate.
    const bytes = new Uint8Array([
      ...box('ftyp', [0, 0, 0, 0]),
      0,
      0,
      0,
      4,
      0x66,
      0x72,
      0x65,
      0x65,
    ]);
    expect(() => parseBoxes(bytes, 0, bytes.length)).toThrow(MalformedFileError);
  });

  it('rejects a 64-bit size larger than any real file', () => {
    // size === 1 means a 64-bit largesize follows. A non-zero high word is
    // beyond both any real file and JavaScript's safe integer range.
    const bytes = new Uint8Array(24);
    bytes.set([0, 0, 0, 1], 0);
    bytes.set([0x66, 0x74, 0x79, 0x70], 4);
    bytes.set([0xff, 0xff, 0xff, 0xff], 8); // high word of largesize
    expect(() => parseBoxes(bytes, 0, bytes.length)).toThrow(MalformedFileError);
  });
});
