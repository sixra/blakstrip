/**
 * The redaction-box geometry, tested through the interface it now has.
 *
 * These assertions used to live in the textlayer suite, importing three
 * functions that `textlayer.ts` exported solely so they could be reached and
 * labelled "Exported for test". That is an internal seam in a public surface.
 * Moving the cluster into its own module turns the same checks into a
 * description of what that module promises.
 */
import { describe, expect, it } from 'vitest';
import {
  matchExtentX,
  measurementFamily,
  safetyMargin,
  verticalCover,
} from '../../src/lib/pdf/glyph-geometry';

describe('glyph geometry', () => {
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

  it('takes whichever safety margin is larger', () => {
    // A hairline page fraction protects small type on a big page; the font-height
    // fraction protects large type, where per-glyph measurement is least reliable.
    expect(safetyMargin(1000, 1)).toBeCloseTo(1.5, 6);
    expect(safetyMargin(1, 100)).toBeCloseTo(8, 6);
  });
});
