/**
 * Orchestrate export: build the redacted document, strip every leak vector, and
 * serialize to a single-revision PDF (pdf-lib always does a full rewrite, so no
 * incremental-update history rides along).
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { stripAll } from './metadata';
import { buildRedactedPdf } from './redact';
import type { RedactionRect } from './types';

/**
 * Build → strip → save. Returns the finished PDF bytes. pdf-lib stamps its
 * Producer at document-creation time (not on save), so a single stripAll pass
 * before save() leaves the metadata clean.
 */
export async function exportRedactedPdf(
  pristine: ArrayBuffer,
  pdfjsDoc: PDFDocumentProxy,
  rects: RedactionRect[],
  onPage?: (done: number, total: number) => void
): Promise<Uint8Array> {
  const out = await buildRedactedPdf(pristine, pdfjsDoc, rects, onPage);
  stripAll(out);
  return out.save({ useObjectStreams: true });
}
