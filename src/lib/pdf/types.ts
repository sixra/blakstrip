/**
 * Shared data contracts for the redaction engine: plain, serializable shapes
 * with no pdf.js / pdf-lib / DOM types, so the UI and tests can pass them around
 * freely. (Engine *functions* still take and return vendor handles such as
 * PDFDocumentProxy where they must; only the types declared here are vendor-free.)
 */

/**
 * A region to redact, stored in **normalized page coordinates**: fractions of
 * the page's width/height with the origin at the top-left (the same orientation
 * the user sees on screen). Resolution-independent: maps trivially to a canvas
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
   * The exact text this rect was created to cover, when known; set for rects
   * produced by search-redaction. Carried into verify so the precise term (not
   * just the coarse run under a hand-drawn box) is confirmed absent from the
   * output. Undefined for hand-drawn boxes. Travels with the rect, so undo/redo
   * keep the verification terms and the redactions perfectly in sync.
   */
  term?: string;
}

export type FindingSeverity = 'high' | 'medium';

export type FindingCategory =
  'metadata' | 'xmp' | 'attachment' | 'annotation' | 'javascript' | 'structure';

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
  /**
   * True if any page exposes extractable text. A document with none is almost
   * certainly a scan, which is the same fact, so it is not stored twice.
   */
  hasTextLayer: boolean;
  findings: Finding[];
}

/** Result of re-inspecting the exported bytes: the proof shown before download. */
export interface VerifyReport {
  /** True when nothing sensitive survived. */
  clean: boolean;
  /** Strings still recoverable via text extraction from the output. */
  recoverableStrings: string[];
  /** Findings that still leak in the output (should be empty). */
  remaining: Finding[];
  /** Redacted search terms that still appear in the output (should be empty). */
  leakedTerms: string[];
  /**
   * Text a hand-drawn box covered on its own page that is still readable on a
   * page the user did not redact. Not a failed redaction: the box did its job,
   * and the same words simply appear again elsewhere. Reported separately so the
   * remedy ("redact it on page 3 too") is obvious, rather than being mixed in
   * with redactions that actually failed.
   */
  survivingElsewhere: { term: string; pages: number[] }[];
  /**
   * Redaction rects whose target isn't actually black in the output raster: a
   * box that under-covered its glyphs, or a page that failed to rasterize. Empty
   * when every redaction is proven covered by the pixel check (should be empty).
   */
  uncoveredRegions: RedactionRect[];
}
