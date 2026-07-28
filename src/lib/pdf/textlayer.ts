/**
 * Text extraction and search over pdf.js pages. Produces plain strings (for
 * audit/verify) and normalized redaction rects (for search-redact-all). The
 * on-screen selectable text layer (drag-select) is wired in the UI step.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { RedactionRect } from './types';

/** The subset of a pdf.js text item we rely on (avoids importing internals). */
interface GlyphItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
  fontName?: string;
}

function isGlyph(item: unknown): item is GlyphItem {
  return typeof (item as { str?: unknown }).str === 'string';
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

// Vertical over-cover: minimal, so a box hugs its line without bleeding into the
// rows above/below. Horizontal position/width is measured (below), so it needs
// only a hairline horizontal safety margin.
const PAD_Y = 0.0012;
const SAFETY_X = 0.0015;

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
function glyphBox(
  item: GlyphItem,
  pw: number,
  ph: number
): { x: number; y: number; w: number; h: number } {
  const { originX, fontH, descent, topPdf } = glyphMetrics(item);
  return {
    x: originX / pw,
    y: (ph - topPdf) / ph,
    w: item.width / pw,
    h: (fontH + descent) / ph,
  };
}

/** Do two axis-aligned top-left boxes overlap at all? Exported for direct test. */
export function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
  return !apart;
}

/**
 * Find every occurrence of `term` on a page and return redaction rects in
 * normalized top-left coordinates. Matches span text runs (pdf.js splits a
 * visual line into many items for kerning/justification/font changes), so the
 * page text is concatenated and each hit maps back to a rect per run segment it
 * covers. Sub-string position within a run is estimated proportionally (pdf.js
 * gives run width, not per-glyph advances), then padded — redaction errs toward
 * covering slightly more, never less.
 */
export async function searchPageRects(
  page: PDFPageProxy,
  term: string,
  opts: { caseSensitive?: boolean } = {}
): Promise<RedactionRect[]> {
  if (!term) return [];
  const { width: pw, height: ph } = page.getViewport({ scale: 1 });
  const needle = opts.caseSensitive ? term : term.toLowerCase();
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, { fontFamily?: string }>;
  const ctx = textMeasurer();

  // Flatten runs into one string, remembering where each run sits in it so a
  // match's character span can be attributed back to the runs it crosses.
  let hay = '';
  const runs: { item: GlyphItem; start: number }[] = [];
  for (const item of content.items) {
    /* v8 ignore next -- marked-content / empty-run items don't occur in our text PDFs */
    if (!isGlyph(item) || item.str.length === 0) continue;
    runs.push({ item, start: hay.length });
    hay += opts.caseSensitive ? item.str : item.str.toLowerCase();
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

      const { originX, fontH, topPdf } = glyphMetrics(item);
      // Tighter than glyphMetrics' 0.28 so the box hugs the line: still clears
      // descenders (g/y/p), without reaching into the row below.
      const descent = fontH * 0.22;
      const localStart = from - runStart;

      // Measure where the match actually sits inside the run. Font size is
      // arbitrary (100) since we rescale to the run's true advance; that scale
      // also corrects for the browser substituting a font family.
      /* v8 ignore next -- runs always carry a font name in our PDFs */
      const family = styles[item.fontName ?? '']?.fontFamily ?? 'sans-serif';
      ctx.font = `100px ${family}`;
      const scale = item.width / ctx.measureText(item.str).width;
      const preW = ctx.measureText(item.str.slice(0, localStart)).width * scale;
      const matchW = ctx.measureText(item.str.slice(localStart, to - runStart)).width * scale;

      // Clamp to the run's own extent so a box can never reach into an adjacent
      // word (a separate run); the measurement keeps it off same-run neighbours.
      const runLeft = originX / pw;
      const runRight = (originX + item.width) / pw;
      const nLeft = Math.max(runLeft, (originX + preW) / pw - SAFETY_X);
      const nRight = Math.min(runRight, (originX + preW + matchW) / pw + SAFETY_X);

      // pdf.js user space is bottom-left; convert the vertical box to top-left.
      const y = (ph - topPdf) / ph - PAD_Y;
      const h = (fontH + descent) / ph + PAD_Y * 2;
      rects.push({
        page: page.pageNumber,
        x: Math.max(0, nLeft),
        y: Math.max(0, y),
        w: Math.min(1, nRight - nLeft),
        h: Math.min(1, h),
        term, // the exact query, so verify can confirm it survives nowhere
      });
    }
  }
  return rects;
}

/**
 * The text sitting under a set of redaction rects — the terms an export must no
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
    const { width: pw, height: ph } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const item of content.items) {
      /* v8 ignore next -- marked-content / empty-run items don't occur in our text PDFs */
      if (!isGlyph(item) || item.str.trim().length === 0) continue;
      const box = glyphBox(item, pw, ph);
      if (pageRects.some((r) => overlaps(box, r))) terms.add(item.str.trim());
    }
  }
  return [...terms];
}

/** Search every page; returns all match rects across the document. */
export async function searchDocumentRects(
  doc: PDFDocumentProxy,
  term: string,
  opts: { caseSensitive?: boolean } = {}
): Promise<RedactionRect[]> {
  const all: RedactionRect[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    all.push(...(await searchPageRects(page, term, opts)));
  }
  return all;
}
