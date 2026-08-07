/**
 * Bounds-checked reads over untrusted bytes.
 *
 * Every parser in this directory reads through these rather than indexing
 * directly. A hostile or truncated file must fail fast with a clear error, never
 * silently read `undefined` and carry a NaN through the rest of the parse until
 * it surfaces as a wrong answer about what a file contains.
 */

/** A file we could not parse. Carries no user data: only what went wrong. */
export class MalformedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedFileError';
  }
}

function need(bytes: Uint8Array, at: number, count: number, what: string): void {
  // The integer check is not paranoia: `NaN < 0` and `NaN + count > length` are
  // both false, so a NaN offset would sail through a range-only guard and index
  // to `undefined` typed as `number`. A fractional offset does the same. Either
  // one would then propagate silently as 0 through the rest of the parse, which
  // is precisely the failure mode these readers exist to prevent.
  if (!Number.isInteger(at)) {
    throw new MalformedFileError(`bad ${what} offset: ${at} is not an integer`);
  }
  if (at < 0 || at + count > bytes.length) {
    throw new MalformedFileError(
      `truncated ${what}: needed ${count} byte(s) at ${at}, file is ${bytes.length}`
    );
  }
}

export function u8(bytes: Uint8Array, at: number): number {
  need(bytes, at, 1, 'u8');
  return bytes[at];
}

export function u16be(bytes: Uint8Array, at: number): number {
  need(bytes, at, 2, 'u16be');
  return (bytes[at] << 8) | bytes[at + 1];
}

export function u32be(bytes: Uint8Array, at: number): number {
  need(bytes, at, 4, 'u32be');
  // >>> 0 keeps the result unsigned: << on a byte >= 0x80 would otherwise make
  // the whole expression negative, and these are offsets and lengths.
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

export function u16le(bytes: Uint8Array, at: number): number {
  need(bytes, at, 2, 'u16le');
  return (bytes[at + 1] << 8) | bytes[at];
}

export function u32le(bytes: Uint8Array, at: number): number {
  need(bytes, at, 4, 'u32le');
  return ((bytes[at + 3] << 24) | (bytes[at + 2] << 16) | (bytes[at + 1] << 8) | bytes[at]) >>> 0;
}

/** Read `count` bytes as ASCII, stopping at the first NUL. */
export function ascii(bytes: Uint8Array, at: number, count: number): string {
  need(bytes, at, count, 'ascii');
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const c = bytes[at + i];
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

/** Does `bytes` carry exactly this ASCII marker at `at`? False when truncated. */
export function matches(bytes: Uint8Array, at: number, marker: string): boolean {
  if (at + marker.length > bytes.length) return false;
  for (let i = 0; i < marker.length; i += 1) {
    if (bytes[at + i] !== marker.charCodeAt(i)) return false;
  }
  return true;
}

/** Concatenate chunks into one buffer, allocating exactly once. */
export function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
