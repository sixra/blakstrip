/**
 * The one PDF-specific thing about saving a redacted file: what to call it.
 *
 * Saving the bytes lives in `src/lib/download.ts`, shared with the media engine.
 * There used to be a `downloadPdf` wrapper here too; it passed its arguments
 * through and added the MIME literal, which is not worth a module boundary. The
 * media side never had one, so removing it also removed an asymmetry.
 */

/** Turn an input filename into its redacted counterpart. */
export function redactedFileName(name: string): string {
  return `${name.replace(/\.pdf$/i, '')}-redacted.pdf`;
}
