/**
 * Verify-on-export: re-inspect the bytes we just produced and demonstrate what
 * is (and isn't) still recoverable. A proof shown before download, not a
 * reassurance. Runs the same extraction an attacker would.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { checkCoverage } from './coverage';
import { inspectStructure } from './inspect';
import { loadPdf } from './render';
import { extractAllText } from './textlayer';
import type { RedactionRect, VerifyReport } from './types';

/** Escape a user term for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A term counts as leaked only when it survives as a whole token (bounded by a
 * non-word character or a string edge), not as an incidental substring. Without
 * this, redacting "Lee" would flag every "flee" in the output and train users to
 * dismiss the warning that matters.
 */
function survivesAsWord(haystack: string, term: string): boolean {
  return new RegExp(`(^|\\W)${escapeRegExp(term.toLowerCase())}(\\W|$)`).test(haystack);
}

/** Text still extractable from the output, de-duplicated and trimmed. */
async function recoverableStrings(doc: PDFDocumentProxy): Promise<string[]> {
  const text = await extractAllText(doc);
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set(lines)];
}

/**
 * Verify exported bytes against the terms the user redacted. A term counts as
 * leaked if it still appears in the recoverable text of the output.
 *
 * When `coverage` is supplied (the source pdf.js doc + the rects that were
 * applied), the pixel-coverage backstop also runs: it re-reads the output raster
 * and flags any redaction that didn't actually paint over its target, so a
 * geometric under-cover can't be certified clean. Omitted only by unit tests
 * that exercise the text/structure paths in isolation.
 */
export async function verifyExport(
  bytes: Uint8Array,
  redactedTerms: string[] = [],
  coverage?: { doc: PDFDocumentProxy; rects: RedactionRect[] }
): Promise<VerifyReport> {
  // One parse of the output, shared by the text and pixel checks. Loading it per
  // check spins up a second pdf.js worker over the same bytes, which on a large
  // export is another full document parsed for nothing.
  const outDoc = await loadPdf(bytes);
  try {
    const strings = await recoverableStrings(outDoc);
    const remaining = await inspectStructure(bytes);

    const haystack = strings.join('\n').toLowerCase();
    const leakedTerms = redactedTerms.filter(
      (t) => t.trim().length > 0 && survivesAsWord(haystack, t.trim())
    );

    const uncoveredRegions = coverage
      ? await checkCoverage(coverage.doc, coverage.rects, outDoc)
      : [];

    return {
      clean: remaining.length === 0 && leakedTerms.length === 0 && uncoveredRegions.length === 0,
      recoverableStrings: strings,
      remaining,
      leakedTerms,
      uncoveredRegions,
    };
  } finally {
    await outDoc.loadingTask.destroy(); // free the throwaway worker
  }
}
