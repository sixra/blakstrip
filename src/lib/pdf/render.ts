/**
 * pdf.js rendering — framework-free. Loads bytes with zero network, renders
 * pages to canvas (on-screen and offscreen for rasterization).
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
// Vite resolves the bundled, same-origin worker file → satisfies `worker-src 'self'`.
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerSrc;

/**
 * Load a PDF from raw bytes. pdf.js *transfers and neuters* the array into its
 * worker, so we hand it a copy — the caller keeps the pristine buffer for
 * pdf-lib during export.
 *
 * `useWasm: false` keeps the CSP strict: pure-JS decoders mean no
 * `wasm-unsafe-eval` is ever needed. (If a JBIG2/JPEG2000 scan fails to decode,
 * host `pdfjs-dist/wasm/` same-origin, set `wasmUrl`, and allow
 * `wasm-unsafe-eval` — `connect-src 'none'` stays intact either way.)
 */
export function loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const task = getDocument({ data: data.slice(0), useWasm: false });
  return task.promise;
}

/** Page dimensions in PDF user-space points (scale 1). */
export function getPageSize(page: PDFPageProxy): { width: number; height: number } {
  const vp = page.getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height };
}

// Conservative cross-browser canvas ceilings. WebKit caps total area near 16.7M
// device pixels and each side well below Chrome's 65k; a page rasterized past
// either limit yields a blank or truncated canvas — a "redacted" page with
// nothing painted. These sit under the tightest (WebKit) limit.
const MAX_CANVAS_SIDE = 8192;
const MAX_CANVAS_AREA = 16_777_216;

/**
 * The largest scale ≤ `scale` that keeps a `width`×`height` point page within
 * both canvas ceilings, so an oversized page renders smaller instead of blanking.
 * Exported for test.
 */
export function clampScale(width: number, height: number, scale: number): number {
  return Math.min(
    scale,
    MAX_CANVAS_SIDE / width,
    MAX_CANVAS_SIDE / height,
    Math.sqrt(MAX_CANVAS_AREA / (width * height))
  );
}

/**
 * Start rendering a page into an on-screen canvas fitted to `cssWidth` CSS
 * pixels, sharpened for HiDPI displays. Returns the live `RenderTask` (so the
 * caller can `.cancel()` it before starting another render on the same canvas —
 * a second concurrent render throws) plus the CSS-pixel dimensions used for
 * layout. The canvas is sized synchronously; await `task.promise` for the pixels.
 */
export function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  cssWidth: number
): { task: RenderTask; cssWidth: number; cssHeight: number } {
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const viewport = page.getViewport({ scale });
  // This module only runs in the browser island, so window always exists.
  const outputScale = window.devicePixelRatio || 1;

  const ctx = canvas.getContext('2d');
  /* v8 ignore next -- a real 2D context is always available in the browser */
  if (!ctx) throw new Error('2D canvas context unavailable');

  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

  const task = page.render({ canvas, canvasContext: ctx, viewport, transform });

  return {
    task,
    cssWidth: Math.floor(viewport.width),
    cssHeight: Math.floor(viewport.height),
  };
}

/**
 * Render a page to a detached canvas at an explicit device-pixel `scale`. Used
 * by the export path to rasterize redacted pages at high resolution before the
 * black boxes are painted and the flattened image is embedded.
 */
export async function renderPageToImageCanvas(
  page: PDFPageProxy,
  scale: number
): Promise<HTMLCanvasElement> {
  const base = page.getViewport({ scale: 1 });
  // Cap the scale so a very large page can't exceed a browser canvas limit and
  // silently render blank — a redacted page that shipped with nothing painted.
  const viewport = page.getViewport({ scale: clampScale(base.width, base.height, scale) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  /* v8 ignore next -- a real 2D context is always available in the browser */
  if (!ctx) throw new Error('2D canvas context unavailable');
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}
