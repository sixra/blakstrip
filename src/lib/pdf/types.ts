/**
 * Shared contracts for the framework-free redaction engine.
 * No pdf.js / pdf-lib / DOM types leak out of here so the UI and tests can
 * depend on plain data.
 */

/**
 * A region to redact, stored in **normalized page coordinates**: fractions of
 * the page's width/height with the origin at the top-left (the same orientation
 * the user sees on screen). Resolution-independent — maps trivially to a canvas
 * at any scale for rasterization, and to PDF user space (with a y-flip) later.
 */
export interface RedactionRect {
  /** 1-based page number. */
  page: number;
  /** Left edge, 0..1 of page width. */
  x: number;
  /** Top edge, 0..1 of page height. */
  y: number;
  /** Width, 0..1 of page width. */
  w: number;
  /** Height, 0..1 of page height. */
  h: number;
  /**
   * The exact text this rect was created to cover, when known — set for rects
   * produced by search-redaction. Carried into verify so the precise term (not
   * just the coarse run under a hand-drawn box) is confirmed absent from the
   * output. Undefined for hand-drawn boxes. Travels with the rect, so undo/redo
   * keep the verification terms and the redactions perfectly in sync.
   */
  term?: string;
}

export type FindingSeverity = 'high' | 'medium' | 'low' | 'info';

export type FindingCategory =
  'metadata' | 'xmp' | 'attachment' | 'annotation' | 'form' | 'javascript' | 'structure';

/** One thing discovered hiding in a document (audit) or still present (verify). */
export interface Finding {
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  /** Short, human title, e.g. "Author metadata". */
  title: string;
  /** Specifics, e.g. the actual value or a count. */
  detail: string;
}

/** Result of inspecting a document on load. */
export interface AuditReport {
  pageCount: number;
  /** True if any page exposes extractable text (vs a pure scan). */
  hasTextLayer: boolean;
  /** Heuristic: image-only pages with no text → likely a scan. */
  isLikelyScan: boolean;
  findings: Finding[];
}

/** Result of re-inspecting the exported bytes — the proof shown before download. */
export interface VerifyReport {
  /** True when nothing sensitive survived. */
  clean: boolean;
  /** Strings still recoverable via text extraction from the output. */
  recoverableStrings: string[];
  /** Findings from the original audit that are now gone. */
  removed: Finding[];
  /** Findings that still leak in the output (should be empty). */
  remaining: Finding[];
  /** Redacted search terms that still appear in the output (should be empty). */
  leakedTerms: string[];
}
