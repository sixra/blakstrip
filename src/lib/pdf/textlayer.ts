/**
 * Text extraction and search over pdf.js pages. Produces plain strings (for
 * audit/verify) and normalized redaction rects (for search-redact-all). The
 * on-screen selectable text layer (drag-select) is wired in the UI step.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import {
  matchExtentX,
  measurementFamily,
  safetyMargin,
  verticalCover,
  type GlyphItem,
  type TextStyleMetrics,
} from './glyph-geometry';
import type { RedactionRect } from './types';

function isGlyph(item: unknown): item is GlyphItem {
  return typeof (item as { str?: unknown }).str === 'string';
}

/** An axis-aligned rect in normalized top-left page fractions. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The subset of a pdf.js PageViewport we need: the rotation-aware transform from
 * PDF user space to on-screen device space, the device dimensions, and the
 * user-space page box (for scaling pads into user-space points).
 */
interface Viewport {
  transform: number[];
  width: number;
  height: number;
  viewBox: number[];
}

/**
 * Map an axis-aligned box given in PDF user-space points (origin bottom-left,
 * y-up) to a normalized top-left rect on the rendered page. All four corners are
 * pushed through the viewport transform and the axis-aligned bounds taken, so a
 * page's `/Rotate` (90/180/270) lands the box in the correct on-screen quadrant.
 * For an unrotated page the transform is a plain scale + y-flip, reducing this to
 * the divide-by-page-size the geometry used before.
 */
function normalizeUserBox(vp: Viewport, x0: number, y0: number, x1: number, y1: number): Box {
  const t = vp.transform;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [ux, uy] of [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]) {
    const nx = (ux * t[0] + uy * t[2] + t[4]) / vp.width;
    const ny = (ux * t[1] + uy * t[3] + t[5]) / vp.height;
    if (nx < minX) minX = nx;
    if (nx > maxX) maxX = nx;
    if (ny < minY) minY = ny;
    if (ny > maxY) maxY = ny;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Concatenate a page's text as it reads, inserting newlines at EOL markers. */
export async function extractPageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  let out = '';
  for (const item of content.items) {
    /* v8 ignore next -- marked-content items (no str) only appear in tagged PDFs */
    if (!isGlyph(item)) continue;
    out += item.str;
    if (item.hasEOL) out += '\n';
  }
  return out;
}

/** All text across the document (used by verify to list recoverable strings). */
export async function extractAllText(doc: PDFDocumentProxy): Promise<string> {
  const parts: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    parts.push(await extractPageText(page));
  }
  return parts.join('\n');
}

/** Bucket rects by their 1-based page number, preserving order within a page. */
export function groupRectsByPage(rects: RedactionRect[]): Map<number, RedactionRect[]> {
  const byPage = new Map<number, RedactionRect[]>();
  for (const r of rects) {
    const arr = byPage.get(r.page);
    if (arr) arr.push(r);
    else byPage.set(r.page, [r]);
  }
  return byPage;
}

/** Does this page expose any non-whitespace text? (vs a pure scan.) */
export async function pageHasText(page: PDFPageProxy): Promise<boolean> {
  const content = await page.getTextContent();
  return content.items.some((i) => isGlyph(i) && i.str.trim().length > 0);
}

/** Does any page in the document expose text? */
export async function documentHasText(doc: PDFDocumentProxy): Promise<boolean> {
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    if (await pageHasText(page)) return true;
  }
  return false;
}

// Callers guarantee a non-empty needle (searchPageRects returns early on an
// empty term), so no empty-needle guard is needed here.
function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    out.push(at);
    from = at + needle.length;
  }
  return out;
}

// One reused 2D context for measuring glyph advances. pdf.js gives a run's exact
// total width but not where each glyph sits inside it; the browser's own font
// metrics supply the realistic *distribution* of that width across characters
// (digits, spaces, punctuation, caps) that a per-character average gets wrong.
// Rescaling the measurement to the run's true width also corrects for the
// browser substituting a different font family.
let measureCtx: CanvasRenderingContext2D | null = null;
function textMeasurer(): CanvasRenderingContext2D {
  /* v8 ignore next -- a 2D context is always available in the browser island */
  measureCtx ??= document.createElement('canvas').getContext('2d');
  return measureCtx as CanvasRenderingContext2D;
}

/** Baseline-relative geometry of a text run, in PDF user-space points. */
function glyphMetrics(item: GlyphItem): {
  originX: number;
  baselineY: number;
  fontH: number;
  descent: number;
  topPdf: number;
} {
  const tr = item.transform;
  const originX = tr[4];
  const baselineY = tr[5];
  /* v8 ignore next -- pdf.js always provides item.height; the fallbacks are defensive */
  const fontH = item.height || Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]);
  const descent = fontH * 0.28; // cover descenders below the baseline
  return { originX, baselineY, fontH, descent, topPdf: baselineY + fontH };
}

/** The run's bounding box in normalized top-left fractions of the page. */
function glyphBox(item: GlyphItem, vp: Viewport): Box {
  const { originX, baselineY, descent, topPdf } = glyphMetrics(item);
  return normalizeUserBox(vp, originX, baselineY - descent, originX + item.width, topPdf);
}

/** A text run's authoritative bounding box (from pdf.js metrics), plus its text. */
export interface RunBox extends Box {
  str: string;
}

/**
 * Every non-blank text run on a page as a normalized box derived purely from
 * pdf.js glyph metrics (`transform`/`width`/`height`), independent of the
 * measured search geometry that places redaction rects. Verify uses these as the
 * ground truth for "where the ink is" when checking the output raster actually
 * covers it, so a placement bug can't hide behind the same measurement twice.
 */
export async function pageRunBoxes(page: PDFPageProxy): Promise<RunBox[]> {
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const boxes: RunBox[] = [];
  for (const item of content.items) {
    /* v8 ignore next -- marked-content / empty-run items don't occur in our text PDFs */
    if (!isGlyph(item) || item.str.trim().length === 0) continue;
    boxes.push({ ...glyphBox(item, vp), str: item.str });
  }
  return boxes;
}

/** Do two axis-aligned top-left boxes overlap at all? Exported for direct test. */
export function overlaps(a: Box, b: Box): boolean {
  const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
  return !apart;
}

/**
 * Find every occurrence of `term` on a page and return redaction rects in
 * normalized top-left coordinates. Matches span text runs (pdf.js splits a
 * visual line into many items for kerning/justification/font changes), so the
 * page text is concatenated and each hit maps back to a rect per run segment it
 * covers. Sub-string position within a run is estimated proportionally (pdf.js
 * gives run width, not per-glyph advances), then padded; redaction errs toward
 * covering slightly more, never less.
 */
export async function searchPageRects(page: PDFPageProxy, term: string): Promise<RedactionRect[]> {
  if (!term) return [];
  const vp = page.getViewport({ scale: 1 });
  // Page width in user space (pre-rotation), for the page-fraction floor on the
  // horizontal safety margin (the font-relative part is computed per run below).
  const uw = vp.viewBox[2] - vp.viewBox[0];
  const needle = term.toLowerCase();
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, TextStyleMetrics>;
  const ctx = textMeasurer();

  // Flatten runs into one string, remembering where each run sits in it so a
  // match's character span can be attributed back to the runs it crosses.
  let hay = '';
  const runs: { item: GlyphItem; start: number }[] = [];
  for (const item of content.items) {
    /* v8 ignore next -- marked-content / empty-run items don't occur in our text PDFs */
    if (!isGlyph(item) || item.str.length === 0) continue;
    runs.push({ item, start: hay.length });
    hay += item.str.toLowerCase();
  }

  const rects: RedactionRect[] = [];
  for (const matchStart of indicesOf(hay, needle)) {
    const matchEnd = matchStart + needle.length; // exclusive
    for (const { item, start: runStart } of runs) {
      const runEnd = runStart + item.str.length; // exclusive
      // Intersection of [matchStart, matchEnd) with this run's char range.
      const from = Math.max(matchStart, runStart);
      const to = Math.min(matchEnd, runEnd);
      if (from >= to) continue; // this run isn't part of the match

      const { baselineY, fontH } = glyphMetrics(item);
      const localStart = from - runStart;
      const localEnd = to - runStart;
      // Does the match reach a run boundary? If so the box snaps to that edge
      // instead of trusting the per-glyph measurement there (see matchExtentX).
      const atRunStart = localStart === 0;
      const atRunEnd = localEnd === item.str.length;
      // Wider safety margin for larger type, where measurement drifts most.
      const safetyX = safetyMargin(uw, fontH);

      // Measure where the match actually sits inside the run. Font size is
      // arbitrary (100) since we rescale to the run's true advance; that scale
      // also corrects for the browser substituting a font family.
      const style = styles[item.fontName] as TextStyleMetrics | undefined;
      ctx.font = `100px ${measurementFamily(style)}`;
      const scale = item.width / ctx.measureText(item.str).width;
      const preW = ctx.measureText(item.str.slice(0, localStart)).width * scale;
      const matchW = ctx.measureText(item.str.slice(localStart, localEnd)).width * scale;

      // Work in user-space points along the baseline (RTL runs cover the whole
      // run; LTR runs use the measured, run-clamped sub-extent, snapped to run
      // boundaries the match reaches), then map the box through the viewport
      // transform so rotated pages land over the glyphs. Vertical extent is
      // font-relative so tall type keeps its descenders and ascenders covered.
      const [xL, xR] = matchExtentX(item, preW, matchW, safetyX, atRunStart, atRunEnd);
      const { above, below } = verticalCover(style);
      const box = normalizeUserBox(
        vp,
        xL,
        baselineY - fontH * below,
        xR,
        baselineY + fontH * above
      );
      rects.push({
        page: page.pageNumber,
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        w: Math.min(1, box.w),
        h: Math.min(1, box.h),
        term, // the exact query, so verify can confirm it survives nowhere
      });
    }
  }
  return rects;
}

/**
 * The text sitting under a set of redaction rects: the terms an export must no
 * longer expose. A run counts as covered when its box overlaps any rect on the
 * same page. Fed to verify so a redacted string that survives anywhere in the
 * output is flagged (the same paranoid check an attacker's extraction would do).
 */
export async function collectRedactedText(
  doc: PDFDocumentProxy,
  rects: RedactionRect[]
): Promise<string[]> {
  const byPage = groupRectsByPage(rects);

  const terms = new Set<string>();
  for (const [pageNum, pageRects] of byPage) {
    const page = await doc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const item of content.items) {
      /* v8 ignore next -- marked-content / empty-run items don't occur in our text PDFs */
      if (!isGlyph(item) || item.str.trim().length === 0) continue;
      const box = glyphBox(item, vp);
      if (pageRects.some((r) => overlaps(box, r))) terms.add(item.str.trim());
    }
  }
  return [...terms];
}

/** Search every page; returns all match rects across the document. */
export async function searchDocumentRects(
  doc: PDFDocumentProxy,
  term: string
): Promise<RedactionRect[]> {
  const all: RedactionRect[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    all.push(...(await searchPageRects(page, term)));
  }
  return all;
}
