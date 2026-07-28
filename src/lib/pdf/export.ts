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
  rects: RedactionRect[]
): Promise<Uint8Array> {
  const out = await buildRedactedPdf(pristine, pdfjsDoc, rects);
  stripAll(out);
  return out.save({ useObjectStreams: true });
}

/** Turn an input filename into its redacted counterpart. */
export function redactedFileName(name: string): string {
  return `${name.replace(/\.pdf$/i, '')}-redacted.pdf`;
}

/** Trigger a browser download of bytes with no network involved. */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
  // Uint8Array is a valid BlobPart at runtime; TS 6's generic ArrayBufferLike
  // doesn't narrow to ArrayBuffer, so assert the part type.
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
