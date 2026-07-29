/**
 * Pixel-coverage check: the backstop that lets verify see the only leak the
 * redaction model can produce. A redacted page is flattened to a text-less image,
 * so text extraction alone can never notice a black box that visually
 * *under-covers* a glyph; it would certify a visible leak "clean".
 *
 * The check compares pixels, not geometry: a leak is a pixel that was **ink** in
 * the source page but is **not black** in the exported page. Source ink is the
 * ground truth for "what had to be destroyed" (so blank margins never
 * false-positive), and the exported pixels are the ground truth for "what was
 * actually covered": neither comes from the measured geometry that placed the
 * box, so a placement bug can't pass by agreeing with itself.
 *
 * Search rects are additionally held to the authoritative run boxes from pdf.js
 * metrics (`pageRunBoxes`), so an under-cover that leaks *past the box edge* is
 * inspected too, not just the box interior.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { loadPdf, renderPageToImageCanvas } from './render';
import { groupRectsByPage, pageRunBoxes, type RunBox } from './textlayer';
import type { RedactionRect } from './types';

/** Device-pixel scale for the coverage raster. Enough to resolve thin glyph tails. */
const COVER_SCALE = 2;
/** Source pixel at/below this Rec. 601 luma counts as ink that must be destroyed. */
const INK_LUMA = 110;
/** Output pixel at/below this luma counts as successfully redacted (black). */
const BLACK_LUMA = 24;
/** A region leaks when more than this fraction of its source ink survives visible. */
const MAX_LEAK_FRACTION = 0.03;

interface Rgba {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rec. 601 luma, compositing transparent pixels onto white (a blank page reads light). */
function lumaAt(img: Rgba, i: number): number {
  const a = img.data[i + 3] / 255;
  return (
    a * (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]) + (1 - a) * 255
  );
}

/**
 * Fraction of source-ink pixels in a normalized region that are still visible
 * (not black) in the output. The region is eroded one device pixel per side so
 * the antialiased box boundary doesn't skew the count. Returns 0 when the region
 * is too small to sample or holds no ink; nothing there to leak.
 */
function residualInk(src: Rgba, out: Rgba, r: Region): number {
  const x0 = Math.floor(r.x * src.width) + 1;
  const y0 = Math.floor(r.y * src.height) + 1;
  const x1 = Math.ceil((r.x + r.w) * src.width) - 1;
  const y1 = Math.ceil((r.y + r.h) * src.height) - 1;
  if (x1 <= x0 || y1 <= y0) return 0;

  let ink = 0;
  let leaked = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * src.width + x) * 4;
      if (lumaAt(src, i) <= INK_LUMA) {
        ink += 1;
        if (lumaAt(out, i) > BLACK_LUMA) leaked += 1;
      }
    }
  }
  return ink === 0 ? 0 : leaked / ink;
}

/** Overlap test between a rect and a run box (both normalized, top-left). */
function boxesOverlap(a: RedactionRect, b: RunBox): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/** Does `rect` span the full horizontal extent of `run` (so the whole run should be gone)? */
function spansHorizontally(rect: RedactionRect, run: RunBox): boolean {
  const eps = 1e-4;
  return rect.x <= run.x + eps && rect.x + rect.w >= run.x + run.w - eps;
}

function readImage(canvas: HTMLCanvasElement): Rgba {
  const ctx = canvas.getContext('2d');
  /* v8 ignore next -- a real 2D context is always available in the browser */
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Re-render the exported pages and return any redaction rects whose target isn't
 * actually covered in the output. Catches a page that failed to rasterize (source
 * ink survives under the rect) and a search box that under-covers its glyphs
 * (source ink survives inside the run's authoritative box, past the box edge).
 * Partial matches inside a run fall back to the rect region alone, since the rest
 * of the run is legitimately still visible and must not be flagged.
 */
export async function checkCoverage(
  sourceDoc: PDFDocumentProxy,
  rects: RedactionRect[],
  outputBytes: Uint8Array
): Promise<RedactionRect[]> {
  const byPage = groupRectsByPage(rects);
  if (byPage.size === 0) return [];

  const out = await loadPdf(outputBytes.slice().buffer);
  try {
    const uncovered: RedactionRect[] = [];
    for (const [pageNum, pageRects] of byPage) {
      const outPage = await out.getPage(pageNum);
      const srcPage = await sourceDoc.getPage(pageNum);
      // Source and output pages share point-size, so at one scale their rasters
      // are pixel-aligned and a region maps to the same pixels in both.
      const outImg = readImage(await renderPageToImageCanvas(outPage, COVER_SCALE));
      const srcImg = readImage(await renderPageToImageCanvas(srcPage, COVER_SCALE));
      const runs = await pageRunBoxes(srcPage);

      for (const rect of pageRects) {
        const regions: Region[] = [rect];
        // Search rects (which carry a term) can under-cover past their own edge,
        // so also inspect every run they span end-to-end. Hand-drawn boxes define
        // their own coverage, so the rect region is the whole check.
        if (rect.term !== undefined) {
          for (const run of runs) {
            if (boxesOverlap(rect, run) && spansHorizontally(rect, run)) regions.push(run);
          }
        }
        if (regions.some((reg) => residualInk(srcImg, outImg, reg) > MAX_LEAK_FRACTION)) {
          uncovered.push(rect);
        }
      }
    }
    return uncovered;
  } finally {
    await out.loadingTask.destroy(); // free the throwaway worker
  }
}
