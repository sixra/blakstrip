/**
 * Contracts shared by every engine in the app (PDF today, media alongside it).
 * Plain serializable shapes with no vendor or DOM types, so the UI, the workers
 * and the tests can pass them around freely.
 *
 * The three-phase flow each engine implements is the reason these are shared:
 * audit what is hiding, act on it, then re-inspect the *output* and prove it is
 * gone. A finding means the same thing in all three phases, whatever the format.
 */

export type FindingSeverity = 'high' | 'medium';

export type FindingCategory =
  // PDF structure
  | 'metadata'
  | 'xmp'
  | 'attachment'
  | 'annotation'
  | 'javascript'
  | 'structure'
  // Image containers
  | 'exif'
  | 'gps'
  | 'iptc'
  | 'icc'
  | 'thumbnail'
  | 'makernote'
  | 'container';

/** One thing discovered hiding in a file (audit) or still present (verify). */
export interface Finding {
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  /** Short, human title, e.g. "Author metadata". */
  title: string;
  /** Specifics, e.g. the actual value or a count. */
  detail: string;
}
