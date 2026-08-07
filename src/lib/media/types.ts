/**
 * Contracts shared by every media engine.
 *
 * The formats differ enormously in structure, but the flow over them is the
 * same: audit what is hiding, strip it, re-inspect the output to prove it is
 * gone. Keeping the strip's return shape uniform is what lets a caller dispatch
 * on format without branching on which engine it happened to reach.
 */

/**
 * Something the strip did on purpose that a user would not predict from "remove
 * the metadata", and would notice if it went unsaid.
 *
 * Deliberately not a `Finding`: a finding is something that leaked, whereas a
 * note is a decision taken in the user's interest that still deserves saying out
 * loud. Keeping an orientation tag is the case that exists today.
 */
export interface StripNote {
  id: string;
  title: string;
  detail: string;
}

/** What every engine's strip returns. */
export interface StripResult {
  bytes: Uint8Array;
  /** Empty when the strip removed everything it found, which is the usual case. */
  notes: StripNote[];
}

/**
 * What the caller may ask an engine to keep beyond the essentials.
 *
 * One type rather than one per format: every engine faces the same question,
 * and three identical interfaces would drift the moment a fourth option
 * appeared in only two of them.
 */
export interface KeepOptions {
  /**
   * Keep the embedded colour profile. On by default. It identifies nobody, and
   * dropping it visibly shifts colour on anything wide-gamut, so removing it is
   * a deliberate choice rather than part of "strip the metadata".
   */
  keepColorProfile?: boolean;
}

/**
 * The single note any engine currently produces.
 *
 * Frozen because it is a template, not a value: engines copy it into each
 * result rather than pushing this reference, so a consumer that edits a note
 * (localising it, marking it dismissed in UI state) changes one result instead
 * of every result and the module constant with them.
 */
export const KEPT_ORIENTATION: Readonly<StripNote> = Object.freeze({
  id: 'kept-orientation',
  title: 'Rotation kept',
  detail:
    'This photo stores its pixels rotated and relies on a tag to turn them upright, so that one tag was kept. It records no location, device or time.',
});
