/**
 * Build the redacted document. Pages with redactions are **rasterized**: the
 * page is rendered to a canvas, black boxes are painted into the pixels, and the
 * flattened image replaces the page, so nothing underneath survives. Pages
 * without redactions are copied verbatim from the source so their text stays
 * selectable.
 */
import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getPageSize, renderPageToImageCanvas } from './render';
import { groupRectsByPage } from './textlayer';
import type { RedactionRect } from './types';

/** Device-pixel scale for rasterized pages (~144 DPI at 2×). Tunable. */
const RASTER_SCALE = 2;

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  /* v8 ignore next -- toBlob yields a Blob for a valid canvas */
  if (!blob) throw new Error('Failed to encode redacted page image');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Produce the redacted output as a pdf-lib document (not yet stripped or saved).
 *
 * @param pristine  Original bytes, untouched (pdf-lib reads them to copy pages).
 * @param pdfjsDoc  The already-loaded pdf.js document (renders redacted pages).
 * @param rects     Redactions in normalized coordinates.
 */
export async function buildRedactedPdf(
  pristine: ArrayBuffer,
  pdfjsDoc: PDFDocumentProxy,
  rects: RedactionRect[]
): Promise<PDFDocument> {
  // ignoreEncryption lets load() succeed on a protected file so we can detect it;
  // pdf-lib cannot actually decrypt, so copying its pages would emit ciphertext.
  const src = await PDFDocument.load(pristine, { ignoreEncryption: true });
  if (src.isEncrypted) {
    throw new Error(
      'This PDF is password or permission protected. Remove the protection (re-save it or print to PDF), then open it again.'
    );
  }
  const out = await PDFDocument.create();
  const byPage = groupRectsByPage(rects);
  const pageCount = src.getPageCount();

  for (let i = 0; i < pageCount; i += 1) {
    const pageRects = byPage.get(i + 1);

    if (pageRects && pageRects.length > 0) {
      const page = await pdfjsDoc.getPage(i + 1);
      const canvas = await renderPageToImageCanvas(page, RASTER_SCALE);
      const ctx = canvas.getContext('2d');
      /* v8 ignore next -- a real 2D context is always available in the browser */
      if (!ctx) throw new Error('2D canvas context unavailable');
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#000000';
      for (const r of pageRects) {
        // Snap each edge outward to a whole device pixel. A fractional fillRect
        // is antialiased, leaving a boundary row that blends black with the
        // original pixel underneath, faintly recoverable. Rounding out covers
        // slightly more, never less, matching the "over-cover" policy.
        const x0 = Math.floor(r.x * canvas.width);
        const y0 = Math.floor(r.y * canvas.height);
        const x1 = Math.ceil((r.x + r.w) * canvas.width);
        const y1 = Math.ceil((r.y + r.h) * canvas.height);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
      const png = await canvasToPngBytes(canvas);
      // Release the canvas backing store now rather than waiting for GC: with
      // many redacted pages the retained bitmaps dominate memory and can crash
      // the tab before the single final save().
      canvas.width = 0;
      canvas.height = 0;
      const img = await out.embedPng(png);
      // Use the pdf.js viewport (rotation-aware) so rotated pages aren't
      // stretched; the rasterized image already bakes in the /Rotate.
      const { width, height } = getPageSize(page);
      const outPage = out.addPage([width, height]);
      outPage.drawImage(img, { x: 0, y: 0, width, height });
      page.cleanup(); // drop pdf.js's cached operator list for this page
    } else {
      const [copied] = await out.copyPages(src, [i]);
      out.addPage(copied);
    }
  }

  return out;
}
