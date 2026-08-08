/**
 * Where a redaction box goes, given pdf.js's glyph metrics.
 *
 * Split out of `textlayer.ts` because its tests were reaching past that module's
 * interface: these three were exported with "Exported for test" on them, which is
 * an internal seam in a public surface. Here they *are* the interface, so the
 * same tests describe a module rather than poke a hole in one.
 *
 * Pure computation with no pdf.js dependency beyond the shapes below, which is
 * why it separates cleanly: nothing here touches a document, a page or a canvas.
 */

/** The subset of a pdf.js text item we rely on (avoids importing internals). */
export interface GlyphItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
  /** pdf.js's internal name for the run's font; keys into `TextContent.styles`. */
  fontName: string;
  /** pdf.js reading direction of the run: 'ltr' | 'rtl' | 'ttb'. Always present. */
  dir: string;
}

/** The subset of a pdf.js TextStyle we use, keyed by `item.fontName`. */
export interface TextStyleMetrics {
  fontFamily?: string;
  ascent?: number;
  descent?: number;
}

const ASCENT_FRAC = 1.15;

const DESCENT_FRAC = 0.3;

const SAFETY_X = 0.0015;

const SAFETY_X_FRAC = 0.08;

/**
 * The CSS family to measure glyph advances with. substituting
 * a different family changes the measured distribution and therefore where the
 * box lands, so the fallback should not be an untested default.
 */
export function measurementFamily(style: TextStyleMetrics | undefined): string {
  return style?.fontFamily ?? 'sans-serif';
}

/**
 * How far above and below the baseline to cover, in fractions of the font height.
 * pdf.js reports each font's real ascent and descent as em fractions (descent
 * negative); the padded defaults above normally reach further, so this only binds
 * for the unusual font whose descenders or accents run past them. Taking the max
 * can only grow the box, never shrink it. the fallbacks matter
 * (a missing style must not shrink the box to nothing) and are not otherwise
 * reachable, since pdf.js supplies metrics for every font it reports.
 */
export function verticalCover(style: TextStyleMetrics | undefined): {
  above: number;
  below: number;
} {
  return {
    above: Math.max(ASCENT_FRAC, style?.ascent ?? 0),
    below: Math.max(DESCENT_FRAC, Math.abs(style?.descent ?? 0)),
  };
}

/**
 * The user-space horizontal extent [left, right] a match occupies within a run.
 * pdf.js reorders RTL runs (item.str is logical order while the transform/width
 * describe visual layout), so measuring the substring left-to-right lands the
 * box on the wrong side; for an RTL run cover the whole run instead, an
 * over-cover that is always safe. LTR runs use the measured sub-extent, but when
 * the match reaches a run boundary the extent is snapped to that boundary rather
 * than trusting the per-glyph measurement (unreliable for condensed/substituted
 * fonts), so a leading/trailing glyph can't slip out. Interior edges use the
 * measurement, padded and clamped inside the run..
 */
export function matchExtentX(
  item: GlyphItem,
  preW: number,
  matchW: number,
  safetyX: number,
  atRunStart = false,
  atRunEnd = false
): [number, number] {
  const originX = item.transform[4];
  const runRight = originX + item.width;
  // Anything but plain left-to-right gets the whole run. pdf.js also emits 'ttb'
  // for vertical text, where a left-to-right sub-extent is just as meaningless as
  // it is for the bidi-reordered 'rtl' case. Over-covering is always safe.
  if (item.dir !== 'ltr') return [originX, runRight];
  const left = atRunStart ? originX : Math.max(originX, originX + preW - safetyX);
  const right = atRunEnd ? runRight : Math.min(runRight, originX + preW + matchW + safetyX);
  return [left, right];
}

/**
 * Horizontal safety margin: the larger of a hairline page fraction and a small
 * fraction of the font height, so bigger type gets a proportionally wider margin
 * where per-glyph measurement is least reliable.
 *
 * Lives here rather than at the call site so the two constants behind it stay
 * private. The caller wants a margin, not the recipe for one.
 */
export function safetyMargin(unitWidth: number, fontHeight: number): number {
  return Math.max(SAFETY_X * unitWidth, fontHeight * SAFETY_X_FRAC);
}
