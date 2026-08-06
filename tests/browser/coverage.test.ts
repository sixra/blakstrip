import { describe, expect, it } from 'vitest';
import { checkCoverage, regionLeaks, type Rgba } from '../../src/lib/pdf/coverage';
import { exportRedactedPdf } from '../../src/lib/pdf/export';
import { loadPdf } from '../../src/lib/pdf/render';
import { pageRunBoxes, searchDocumentRects } from '../../src/lib/pdf/textlayer';
import type { RedactionRect } from '../../src/lib/pdf/types';
import { makeGreyTextPdf, makeLargeGlyphPdf, makeTextPdf } from '../support/testpdf';

/** A uniform greyscale image; `v` 0 is ink, 255 is blank paper. */
function solid(width: number, height: number, v: number): Rgba {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(v);
  for (let i = 3; i < data.length; i += 4) data[i] = 255; // opaque
  return { data, width, height };
}

/** Leave `n` pixels of the output white, i.e. `n` source-ink pixels still visible. */
function withVisiblePixels(img: Rgba, n: number): Rgba {
  const out = { ...img, data: new Uint8ClampedArray(img.data) };
  // Start well inside the 1px erosion margin so every one of them is sampled.
  for (let k = 0; k < n; k += 1) {
    const i = ((10 + Math.floor(k / 80)) * img.width + (10 + (k % 80))) * 4;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = 255;
  }
  return out;
}

const WHOLE = { x: 0, y: 0, w: 1, h: 1 };

const wholePage1: RedactionRect = { page: 1, x: 0, y: 0, w: 1, h: 1 };

describe('regionLeaks: the thresholds themselves', () => {
  it('fails closed when the two rasters are not the same size', () => {
    // One index addresses both images, so a mismatch reads out of bounds on the
    // output, yields NaN, and scores every pixel as covered. A safety check must
    // not report "clean" exactly when it has lost the ability to see.
    const src = solid(100, 100, 0); // all ink
    const out = solid(50, 50, 0); // all black, but wrong dimensions
    expect(regionLeaks(src, out, WHOLE)).toBe(true);
  });

  it('flags a large region by absolute pixel count even when the fraction is tiny', () => {
    const src = solid(100, 100, 0); // ~9,604 ink pixels after erosion
    const out = withVisiblePixels(solid(100, 100, 0), 100);
    // 100 / 9604 = 1.0%, comfortably under the 3% fraction — but 100 visible ink
    // pixels is a legible mark, so the absolute ceiling has to catch it.
    expect(regionLeaks(src, out, WHOLE)).toBe(true);
  });

  it('still passes a region whose leak is under both thresholds', () => {
    const src = solid(100, 100, 0);
    const out = withVisiblePixels(solid(100, 100, 0), 10);
    expect(regionLeaks(src, out, WHOLE)).toBe(false);
  });

  it('ignores a region with no source ink at all', () => {
    expect(regionLeaks(solid(100, 100, 255), solid(100, 100, 255), WHOLE)).toBe(false);
  });
});

describe('checkCoverage: pixel backstop', () => {
  it('returns nothing when there are no rects', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    const bytes = await exportRedactedPdf(pristine, doc, [wholePage1]);
    expect(await checkCoverage(doc, [], bytes)).toEqual([]);
  });

  it('passes a correctly covered hand-drawn redaction', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    const bytes = await exportRedactedPdf(pristine, doc, [wholePage1]);
    expect(await checkCoverage(doc, [wholePage1], bytes)).toEqual([]);
  });

  it('passes a correctly covered search redaction', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    const rects = await searchDocumentRects(doc, '123-45-6789');
    expect(rects.length).toBeGreaterThan(0);
    const bytes = await exportRedactedPdf(pristine, doc, rects);
    expect(await checkCoverage(doc, rects, bytes)).toEqual([]);
  });

  it('flags a search box that under-covers its run vertically', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    // The whole line is one run, so the match spans it horizontally: the case
    // where the run's authoritative box is held to account.
    const [rect] = await searchDocumentRects(doc, 'SSN: 123-45-6789');
    expect(rect).toBeDefined();
    // Shrink the box to the bottom 35% of its height: the top of every glyph is
    // left exposed, while the box still spans the run horizontally.
    const shrunk: RedactionRect = { ...rect, y: rect.y + rect.h * 0.65, h: rect.h * 0.35 };
    const bytes = await exportRedactedPdf(pristine, doc, [shrunk]);
    const uncovered = await checkCoverage(doc, [shrunk], bytes);
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]).toEqual(shrunk);
  });

  it('fully covers a large-font run, descenders and all', async () => {
    const pristine = await makeLargeGlyphPdf();
    const doc = await loadPdf(pristine);
    const rects = await searchDocumentRects(doc, 'PgjyQ');
    expect(rects).toHaveLength(1);
    const bytes = await exportRedactedPdf(pristine, doc, rects);
    // Font-relative vertical cover means no glyph tail survives the black box.
    expect(await checkCoverage(doc, rects, bytes)).toEqual([]);
  });

  it('flags a region that was never painted in the output', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    // Export redacts only page 1; page 2's "Appendix … Jane Author" line stays.
    const bytes = await exportRedactedPdf(pristine, doc, [wholePage1]);
    // A hand-drawn box over that surviving page-2 text, as if it hadn't rendered.
    const missed: RedactionRect = { page: 2, x: 0.08, y: 0.1, w: 0.6, h: 0.04 };
    const uncovered = await checkCoverage(doc, [missed], bytes);
    expect(uncovered).toEqual([missed]);
  });

  it('does not flag a partial match that covers only part of a run', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    const runs = await pageRunBoxes(await doc.getPage(1));
    // The "Employee: Jane Author" run: cover its left 40% only, with a term set.
    const run = runs.find((r) => r.str.includes('Employee'));
    if (!run) throw new Error('fixture run not found');
    const partial: RedactionRect = {
      page: 1,
      x: run.x,
      y: run.y,
      w: run.w * 0.4,
      h: run.h,
      term: 'Employee',
    };
    const bytes = await exportRedactedPdf(pristine, doc, [partial]);
    // The covered left part is black; the right part is legitimately still there,
    // and the box does not span the run, so nothing is flagged.
    expect(await checkCoverage(doc, [partial], bytes)).toEqual([]);
  });

  it('ignores a region over blank space (no ink to leak)', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    const bytes = await exportRedactedPdf(pristine, doc, [wholePage1]);
    // Page 2's lower half is empty; a box there samples pixels but finds no ink.
    const blank: RedactionRect = { page: 2, x: 0.1, y: 0.5, w: 0.4, h: 0.1 };
    expect(await checkCoverage(doc, [blank], bytes)).toEqual([]);
  });

  it('treats light-grey ink as content that must be destroyed', async () => {
    const pristine = await makeGreyTextPdf();
    const doc = await loadPdf(pristine);
    const [rect] = await searchDocumentRects(doc, 'GREYSECRET');
    expect(rect).toBeDefined();
    // Shrink to the bottom 35%, leaving the top of every glyph exposed. Grey text
    // sits around luma 150: an ink threshold tuned to black body text would not
    // count it, and this leak would be certified clean.
    const shrunk: RedactionRect = { ...rect, y: rect.y + rect.h * 0.65, h: rect.h * 0.35 };
    const bytes = await exportRedactedPdf(pristine, doc, [shrunk]);
    expect(await checkCoverage(doc, [shrunk], bytes)).toHaveLength(1);
  });

  it('ignores a sub-pixel-thin region (nothing to sample)', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    const bytes = await exportRedactedPdf(pristine, doc, [wholePage1]);
    const sliver: RedactionRect = { page: 1, x: 0.1, y: 0.5, w: 0.3, h: 0.0005 };
    expect(await checkCoverage(doc, [sliver], bytes)).toEqual([]);
  });
});
