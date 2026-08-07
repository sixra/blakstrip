import { describe, expect, it } from 'vitest';
import { loadPdf } from '../../src/lib/pdf/render';
import {
  collectRedactedText,
  documentHasText,
  extractAllText,
  extractPageText,
  matchExtentX,
  measurementFamily,
  overlaps,
  pageHasText,
  pageRunBoxes,
  searchDocumentRects,
  searchPageRects,
  verticalCover,
} from '../../src/lib/pdf/textlayer';
import {
  makeLargeGlyphPdf,
  makeMixedRunPdf,
  makeRotatedPdf,
  makeScanLikePdf,
  makeSplitRunPdf,
  makeTextPdf,
} from '../support/testpdf';

describe('textlayer', () => {
  it('extracts text across all pages', async () => {
    const doc = await loadPdf(await makeTextPdf());
    const text = await extractAllText(doc);
    expect(text).toContain('123-45-6789');
    expect(text).toContain('Jane Author');
  });

  it('extracts a single page', async () => {
    const doc = await loadPdf(await makeTextPdf());
    const t = await extractPageText(await doc.getPage(1));
    expect(t).toContain('SSN');
    expect(t).not.toContain('Appendix');
  });

  it('detects a text layer vs a scan', async () => {
    const textDoc = await loadPdf(await makeTextPdf());
    expect(await documentHasText(textDoc)).toBe(true);
    expect(await pageHasText(await textDoc.getPage(1))).toBe(true);
    const scan = await loadPdf(await makeScanLikePdf());
    expect(await documentHasText(scan)).toBe(false);
  });

  it('finds every instance of a term as normalized rects', async () => {
    const doc = await loadPdf(await makeTextPdf());
    const rects = await searchDocumentRects(doc, 'Jane Author');
    expect(rects.length).toBeGreaterThanOrEqual(2);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.w).toBeLessThanOrEqual(1);
      expect(r.h).toBeLessThanOrEqual(1);
      expect(r.term).toBe('Jane Author'); // exact query travels with the rect
    }
  });

  it('returns nothing for an empty term or no match', async () => {
    const doc = await loadPdf(await makeTextPdf());
    expect(await searchDocumentRects(doc, '')).toEqual([]);
    expect(await searchPageRects(await doc.getPage(1), 'zzzznotpresent')).toEqual([]);
  });

  it('matches case-insensitively', async () => {
    const page = await (await loadPdf(await makeTextPdf())).getPage(1);
    expect((await searchPageRects(page, 'jane author')).length).toBeGreaterThan(0);
    expect((await searchPageRects(page, 'JANE AUTHOR')).length).toBeGreaterThan(0);
  });

  it('finds a term that spans two text runs', async () => {
    const doc = await loadPdf(await makeSplitRunPdf());
    // "CONFIDENTIAL" is drawn as two adjacent items; a per-run search would miss it.
    const rects = await searchDocumentRects(doc, 'CONFIDENTIAL');
    expect(rects.length).toBeGreaterThanOrEqual(1);
  });

  it('boxes only the matched part of a mixed-width run (measured, not averaged)', async () => {
    const page = await (await loadPdf(await makeMixedRunPdf())).getPage(1);

    // "Berlin" inside "10827 Berlin." must sit right of "10827" and exclude ".".
    const berlin = await searchPageRects(page, 'Berlin');
    const num = await searchPageRects(page, '10827');
    const line = await searchPageRects(page, '10827 Berlin.');
    expect(berlin.length).toBe(1);
    expect(num.length).toBe(1);
    // No overlap with the leading number, and short of the trailing period.
    expect(num[0].x + num[0].w).toBeLessThanOrEqual(berlin[0].x + 0.01);
    expect(berlin[0].x + berlin[0].w).toBeLessThan(line[0].x + line[0].w);

    // "621" inside "621412" is the first half, not five of the six digits.
    const p = await searchPageRects(page, '621');
    const all = await searchPageRects(page, '621412');
    expect(p.length).toBe(1);
    expect(p[0].w).toBeLessThan(all[0].w * 0.65);
    expect(p[0].x).toBeCloseTo(all[0].x, 2);
  });

  it('clamps a mid-run match inside its run and stays in bounds', async () => {
    const doc = await loadPdf(await makeTextPdf());
    // 'Jane' sits mid-run inside "Employee: Jane Author", so both edges are the
    // estimated (padded, clamped) path rather than an exact run boundary.
    const rects = await searchDocumentRects(doc, 'Jane');
    expect(rects.length).toBeGreaterThan(0);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.w).toBeGreaterThan(0);
      expect(r.x + r.w).toBeLessThanOrEqual(1);
    }
  });

  it('places the box over the on-screen glyphs on a rotated (/Rotate 90) page', async () => {
    const doc = await loadPdf(await makeRotatedPdf());
    const page = await doc.getPage(1);
    const rects = await searchPageRects(page, 'ROTATEDSECRET');
    expect(rects.length).toBe(1);
    const r = rects[0];
    // Stays on the page.
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(1.001);
    expect(r.y + r.h).toBeLessThanOrEqual(1.001);
    // A horizontal run rendered under /Rotate 90 reads vertically on screen, so
    // the box must be taller than it is wide, proof the rotation was applied
    // (the old divide-by-viewport geometry produced a wide, mislocated box).
    expect(r.h).toBeGreaterThan(r.w);
    // Round-trip: the same rect, overlap-tested in the same coordinate system,
    // recovers the covered text: search and collect agree on where the glyph is.
    const covered = await collectRedactedText(doc, rects);
    expect(covered.some((t) => t.includes('ROTATEDSECRET'))).toBe(true);
  });

  it('collects the text sitting under redaction rects', async () => {
    const doc = await loadPdf(await makeTextPdf());
    const terms = await collectRedactedText(doc, [
      { page: 1, x: 0, y: 0, w: 1, h: 1 }, // covers every run on page 1
      { page: 1, x: 0, y: 0, w: 0.01, h: 0.01 }, // second rect on the same page
      { page: 2, x: 0.9, y: 0.9, w: 0.05, h: 0.05 }, // empty corner, covers nothing
    ]);
    expect(terms.some((t) => t.includes('123-45-6789'))).toBe(true);
    expect(terms.some((t) => t.includes('Appendix'))).toBe(false); // page 2 text not covered
    expect(await collectRedactedText(doc, [])).toEqual([]);
  });

  it('covers the whole run for an RTL match but measures LTR matches', () => {
    // A synthetic pdf.js-shaped run at user-space x=100, width 60.
    const base = {
      str: 'ABC',
      transform: [1, 0, 0, 1, 100, 700],
      width: 60,
      height: 12,
      hasEOL: false,
      fontName: 'g_d0_f1',
    };
    // RTL is bidi-reordered, so a left-to-right measurement is wrong; cover the
    // full run [originX, originX + width] instead.
    expect(matchExtentX({ ...base, dir: 'rtl' }, 10, 20, 0.5)).toEqual([100, 160]);
    // Vertical runs get the same whole-run treatment for the same reason.
    expect(matchExtentX({ ...base, dir: 'ttb' }, 10, 20, 0.5)).toEqual([100, 160]);
    // LTR uses the measured sub-extent, padded and clamped inside the run.
    const [l, r] = matchExtentX({ ...base, dir: 'ltr' }, 10, 20, 0.5);
    expect(l).toBeCloseTo(109.5); // 100 + preW(10) - safetyX(0.5)
    expect(r).toBeCloseTo(130.5); // 100 + preW(10) + matchW(20) + safetyX(0.5)
  });

  it('snaps a match to the run edge it reaches, not the measured guess', () => {
    const base = {
      str: 'ABC',
      transform: [1, 0, 0, 1, 100, 700],
      width: 60,
      height: 12,
      hasEOL: false,
      fontName: 'g_d0_f1',
      dir: 'ltr',
    };
    // A match reaching the run start snaps its left to originX (not preW-padded),
    // and one reaching the run end snaps its right to originX + width, so a
    // condensed/substituted font can't leave the boundary glyph exposed.
    expect(matchExtentX(base, 0, 20, 0.5, true, false)[0]).toBe(100);
    expect(matchExtentX(base, 40, 20, 0.5, false, true)[1]).toBe(160);
    // A match spanning the whole run covers it end to end.
    expect(matchExtentX(base, 0, 60, 0.5, true, true)).toEqual([100, 160]);
  });

  it('snaps a match to the run edge when per-glyph measurement falls short', async () => {
    const doc = await loadPdf(await makeMixedRunPdf());
    const page = await doc.getPage(1);
    const RUN = '10827 Berlin.';

    // A uniform measurement error cannot be observed here: the run's total is
    // rescaled to pdf.js's authoritative width, so any constant factor cancels.
    // What the snap actually defends against is measurement that is short *within*
    // the run, which is what condensed and substituted fonts produce. Model that
    // by under-reporting substrings while leaving the full run honest.
    // Capturing the prototype method to patch it is the point; `this` is
    // supplied explicitly by the .call below, which is what the rule guards.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function (text: string) {
      const { width } = original.call(this, text);
      return { width: text === RUN ? width : width * 0.8 } as TextMetrics;
    };
    try {
      const [berlin] = await searchPageRects(page, 'Berlin.');
      const run = (await pageRunBoxes(page)).find((r) => r.str === RUN);
      if (!run) throw new Error('fixture run not found');
      // The match reaches the end of the run, so its right edge must snap there
      // rather than trust the short measurement and leave the final glyphs bare.
      expect(berlin.x + berlin.w).toBeGreaterThanOrEqual(run.x + run.w - 1e-6);
    } finally {
      CanvasRenderingContext2D.prototype.measureText = original;
    }
  });

  it('falls back to a generic family when a font reports none', () => {
    // Not cosmetic: the family drives measureText, which drives where the box
    // lands, so the fallback is geometry and deserves a test rather than an
    // ignore comment.
    expect(measurementFamily(undefined)).toBe('sans-serif');
    expect(measurementFamily({})).toBe('sans-serif');
    expect(measurementFamily({ fontFamily: 'serif' })).toBe('serif');
  });

  it('falls back to the padded defaults when a font reports no metrics', () => {
    // A missing style entry must not collapse the vertical cover to nothing.
    expect(verticalCover(undefined)).toEqual({ above: 1.15, below: 0.3 });
    expect(verticalCover({})).toEqual({ above: 1.15, below: 0.3 });
    // Real metrics only ever widen it, and descent arrives negative.
    expect(verticalCover({ ascent: 1.4, descent: -0.45 })).toEqual({ above: 1.4, below: 0.45 });
    expect(verticalCover({ ascent: 0.72, descent: -0.21 })).toEqual({ above: 1.15, below: 0.3 });
  });

  it('never covers less than the font its own metrics ask for', async () => {
    // pdf.js reports each font's real ascent/descent, and the padded defaults are
    // normally the larger of the two. Assert that reality holds for a standard
    // font, so the max() in verticalCover is documented rather than assumed, and
    // that the box still clears the run box derived from those same metrics.
    const doc = await loadPdf(await makeLargeGlyphPdf());
    const page = await doc.getPage(1);
    const styles = (await page.getTextContent()).styles as Record<
      string,
      { ascent?: number; descent?: number }
    >;
    const metrics = Object.values(styles)[0];
    expect(metrics.ascent).toBeLessThan(1.15); // the padded default reaches further
    expect(Math.abs(metrics.descent ?? 0)).toBeLessThan(0.3);

    const [rect] = await searchPageRects(page, 'PgjyQ');
    const run = (await pageRunBoxes(page)).find((r) => r.str === 'PgjyQ');
    if (!run) throw new Error('fixture run not found');
    expect(rect.y).toBeLessThanOrEqual(run.y);
    expect(rect.y + rect.h).toBeGreaterThanOrEqual(run.y + run.h);
  });

  it('detects box overlap in every separation direction', () => {
    const box = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    expect(overlaps(box, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 })).toBe(true); // intersecting
    expect(overlaps(box, { x: 0.7, y: 0.4, w: 0.1, h: 0.2 })).toBe(false); // to the right
    expect(overlaps(box, { x: 0.1, y: 0.4, w: 0.1, h: 0.2 })).toBe(false); // to the left
    expect(overlaps(box, { x: 0.4, y: 0.7, w: 0.2, h: 0.1 })).toBe(false); // below
    expect(overlaps(box, { x: 0.4, y: 0.1, w: 0.2, h: 0.1 })).toBe(false); // above
  });
});
