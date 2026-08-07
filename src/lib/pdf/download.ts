/**
 * PDF-specific download helpers. The byte-saving itself now lives in
 * `src/lib/download.ts` so the media engine can use it too; only the naming
 * convention is PDF's own.
 */
import { downloadBytes } from '../download';

/** Turn an input filename into its redacted counterpart. */
export function redactedFileName(name: string): string {
  return `${name.replace(/\.pdf$/i, '')}-redacted.pdf`;
}

/** Trigger a browser download of redacted PDF bytes, with no network involved. */
export function downloadPdf(bytes: Uint8Array, filename: string): void {
  downloadBytes(bytes, filename, 'application/pdf');
}
