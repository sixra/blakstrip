/**
 * Audit-on-load: tell the user what is hiding in the file *before* they redact.
 * Structural leak vectors (shared with verify) plus a text-layer/scan check.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { inspectStructure } from './inspect';
import { documentHasText } from './textlayer';
import type { AuditReport } from './types';

/**
 * Inspect the original document. `pristine` is the untouched bytes (for pdf-lib
 * structure inspection); `pdfjsDoc` is the already-loaded pdf.js document (for
 * text/scan detection).
 */
export async function auditDocument(
  pristine: ArrayBuffer,
  pdfjsDoc: PDFDocumentProxy
): Promise<AuditReport> {
  const findings = await inspectStructure(new Uint8Array(pristine));
  const hasTextLayer = await documentHasText(pdfjsDoc);

  return { hasTextLayer, findings };
}
