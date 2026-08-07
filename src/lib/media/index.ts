/**
 * The media engine's public surface: pick the format from the bytes, then run
 * the same three phases over it that the PDF engine runs over a document.
 *
 * Audit what is hiding, strip it, then re-inspect the *output* and prove it is
 * gone. The third phase is the one that matters: a tool that says "removed" and
 * is believed is worth less than one that shows the file it just produced and
 * lets you check.
 */
import type { Finding } from '../types';
import { inspectIsobmff, isIsobmff, stripIsobmff } from './isobmff';
import { inspectJpeg, isJpeg, stripJpeg } from './jpeg';
import { inspectPng, isPng, stripPng } from './png';
import type { KeepOptions, StripResult } from './types';
import { inspectWebp, isWebp, stripWebp } from './webp';

export type MediaFormat = 'jpeg' | 'png' | 'webp' | 'mp4';

/** A file whose format this tool does not handle. */
export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}

/**
 * Identify the format from the bytes, never from the filename or the browser's
 * reported MIME type. Both are supplied by whoever produced the file and are
 * trivially wrong: a `.png` holding a JPEG must be treated as a JPEG, or the
 * strip would run the wrong parser over it and report a clean file it never
 * actually understood.
 */
export function detectFormat(bytes: Uint8Array): MediaFormat | undefined {
  if (isJpeg(bytes)) return 'jpeg';
  if (isPng(bytes)) return 'png';
  if (isWebp(bytes)) return 'webp';
  // Checked last: its marker sits at offset 4 rather than 0, so it is the only
  // one that could in principle collide with another format's payload.
  if (isIsobmff(bytes)) return 'mp4';
  return undefined;
}

/**
 * The MIME type to hand a Blob for this format, for preview and download.
 *
 * Spelled out per format rather than built as `image/${format}`. That template
 * happens to be right for every format here and becomes wrong the moment a
 * video is added, producing `image/mp4`: a download the OS opens with the wrong
 * application, and a preview `<video>` refuses. A map cannot be wrong quietly,
 * because a new format will not compile until it is listed.
 */
const MIME_TYPES: Record<MediaFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  // The reason this is a map: the template would have made this `image/mp4`.
  mp4: 'video/mp4',
};

export function mimeTypeFor(format: MediaFormat): string {
  return MIME_TYPES[format];
}

/** Every format this engine handles, for the file picker and the refusal message. */
export const SUPPORTED_FORMATS: readonly MediaFormat[] = ['jpeg', 'png', 'webp', 'mp4'];

function requireFormat(bytes: Uint8Array): MediaFormat {
  const format = detectFormat(bytes);
  if (!format) {
    throw new UnsupportedFormatError(
      `unsupported file: expected one of ${SUPPORTED_FORMATS.join(', ')}`
    );
  }
  return format;
}

export interface MediaAudit {
  format: MediaFormat;
  findings: Finding[];
}

/** Phase one: what is hiding in this file? */
export function inspectMedia(bytes: Uint8Array): MediaAudit {
  const format = requireFormat(bytes);
  switch (format) {
    case 'jpeg':
      return { format, findings: inspectJpeg(bytes) };
    case 'png':
      return { format, findings: inspectPng(bytes) };
    case 'webp':
      return { format, findings: inspectWebp(bytes) };
    case 'mp4':
      return { format, findings: inspectIsobmff(bytes) };
  }
}

/** Phase two: remove it, losslessly. */
export function stripMedia(bytes: Uint8Array, options: KeepOptions = {}): StripResult {
  const format = requireFormat(bytes);
  switch (format) {
    case 'jpeg':
      return stripJpeg(bytes, options);
    case 'png':
      return stripPng(bytes, options);
    case 'webp':
      return stripWebp(bytes, options);
    case 'mp4':
      // No colour profile to keep or drop: the option is image-only.
      return stripIsobmff(bytes);
  }
}

export interface MediaVerifyReport {
  /** True when re-reading the output found nothing. */
  clean: boolean;
  /** Anything still present in the output. Should be empty. */
  remaining: Finding[];
}

/**
 * Phase three: re-read the bytes that are about to be downloaded.
 *
 * Deliberately takes the output rather than a handle to the strip that produced
 * it, so it cannot be fooled by what the strip believed it did. The one weakness
 * is shared with any single-parser design: a vector this tool cannot see is
 * invisible to both phases. Allowlist stripping is what limits that, since
 * anything unrecognised is dropped rather than preserved.
 */
export function verifyMedia(bytes: Uint8Array): MediaVerifyReport {
  const remaining = inspectMedia(bytes).findings;
  return { clean: remaining.length === 0, remaining };
}
