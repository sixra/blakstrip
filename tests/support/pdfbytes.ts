import { inflateSync } from 'node:zlib';

/**
 * Does a needle survive anywhere in a PDF's bytes, including inside its
 * compressed streams? Deliberately independent of pdf.js and of blakstrip's own
 * extraction: it is the check an attacker would run against the file on disk,
 * so it can confirm an export without asking the app whether the export is good.
 */
export function outputContains(bytes: Uint8Array, needle: string): boolean {
  const raw = Buffer.from(bytes).toString('latin1');
  if (raw.includes(needle)) return true;
  let idx = 0;
  for (;;) {
    const s = raw.indexOf('stream', idx);
    if (s === -1) break;
    const e = raw.indexOf('endstream', s);
    if (e === -1) break;
    const body = Buffer.from(raw.slice(s + 6, e), 'latin1');
    // The stream body starts after a newline whose form varies; try each offset.
    for (const off of [1, 2, 0]) {
      try {
        if (inflateSync(body.subarray(off)).toString('latin1').includes(needle)) return true;
      } catch {
        /* not a flate stream at this offset */
      }
    }
    idx = e + 9;
  }
  return false;
}
