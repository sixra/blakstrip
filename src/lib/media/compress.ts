/**
 * Compression planning: everything about a compress job that can be decided
 * without a codec, a canvas or a worker.
 *
 * Split out from the worker on purpose. The decisions people actually argue
 * about (which format a preset picks, whether a small image gets upscaled to the
 * dimension cap, what the output file is called) are ordinary arithmetic and
 * string work, and keeping them here means they are tested in Node in
 * milliseconds instead of behind a wasm codec that takes seconds to spin up.
 */
import type { MediaFormat } from './index';

export type CompressPreset = 'smallest' | 'balanced' | 'best';

/**
 * What compression can write, which is deliberately wider than what the engine
 * can read.
 *
 * `MediaFormat` means "a container this app can parse, strip and verify". AVIF is
 * none of those: there is no AVIF parser here, so it can be produced but not
 * audited. Keeping it a separate type is what stops it leaking into `detectFormat`
 * or `stripMedia`, where it would promise something untrue.
 */
export type OutputFormat = MediaFormat | 'avif';

export interface CompressOptions {
  /** The container to encode into, which need not be the source format. */
  format: OutputFormat;
  /**
   * 1 to 100, higher is better looking and larger. Ignored for PNG, which is
   * encoded losslessly: its size comes from `effort` instead.
   */
  quality: number;
  /**
   * OxiPNG's optimisation level, 0 to 6. PNG only. Higher spends more time
   * searching for a smaller file; it never changes a pixel, so this trades
   * seconds for bytes and nothing else.
   */
  effort: number;
  /**
   * Cap on the longest side, in pixels. Undefined leaves the image at its
   * original size. Resizing is by far the largest saving available on a photo
   * straight off a phone, which is why it sits alongside quality rather than
   * being buried.
   */
  maxDimension?: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * The size an image becomes under a longest-side cap, preserving aspect ratio.
 *
 * Never upscales: a cap is a ceiling, and a 400px image asked to fit within 2000
 * should stay 400 rather than being blown up into a blurrier, larger file. That
 * is the case worth naming, because "fit to 2000" reads like an instruction to
 * make it 2000.
 *
 * Rounds to at least 1, so an extreme aspect ratio cannot produce a zero-width
 * canvas, which throws rather than degrading.
 */
export function fitWithin(source: Dimensions, maxDimension?: number): Dimensions {
  const longest = Math.max(source.width, source.height);
  if (!maxDimension || longest <= maxDimension) return { ...source };

  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/**
 * The starting options for a preset, given what the source file is.
 *
 * `smallest` converts everything to WebP because that is where the large wins
 * are, and it carries alpha so a transparent PNG survives the trip. The other
 * two keep the source format: someone who opened a PNG and asked for "best
 * quality" did not ask for a different file type, and a silent conversion is the
 * kind of surprise that costs trust in a tool whose whole pitch is that you can
 * check what it did.
 */
export function optionsForPreset(preset: CompressPreset, source: MediaFormat): CompressOptions {
  switch (preset) {
    case 'smallest':
      return { format: 'webp', quality: 55, effort: 4, maxDimension: 2048 };
    case 'balanced':
      return { format: source, quality: 78, effort: 2 };
    case 'best':
      return { format: source, quality: 92, effort: 2 };
  }
}

const EXTENSIONS: Record<OutputFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
};

/**
 * The download name for a compressed file.
 *
 * The extension is replaced rather than appended, because the output format is
 * frequently not the input's: leaving `holiday.png` on WebP bytes produces a
 * file that some applications refuse to open and others open only by sniffing.
 */
export function compressedFileName(name: string, format: OutputFormat): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}-small.${EXTENSIONS[format]}`;
}

/**
 * How much smaller the output is, as a percentage, rounded to a whole number.
 *
 * Negative when compression made the file bigger, which is a real outcome worth
 * showing rather than clamping away: re-encoding an already-optimised JPEG at
 * high quality, or converting a flat-colour PNG to JPEG, both genuinely grow the
 * file, and a user staring at "0% saved" would reasonably think the tool broke.
 */
export function percentSaved(before: number, after: number): number {
  if (before <= 0) return 0;
  return Math.round(((before - after) / before) * 100);
}

/**
 * The worker protocol.
 *
 * Every message carries the `id` of the job it belongs to. The client raises the
 * id per request and ignores any reply that is not the current one, which is
 * what makes dragging a quality slider safe: a wasm encode already underway
 * cannot be cancelled, so the only honest options are to queue every intermediate
 * value or to discard the stale answers. Discarding is the one users want.
 */
export interface CompressRequest {
  id: number;
  bytes: Uint8Array;
  /**
   * What `bytes` currently is, which is not necessarily what it is becoming.
   *
   * Kept separate from `options.format` so the Blob handed to the decoder is
   * labelled honestly. Chrome sniffs the content and decodes correctly even when
   * the type is wrong (measured: mislabelling PNG bytes as WebP changes nothing),
   * so this is correctness rather than a bug fix, and no test can prove it there.
   */
  sourceFormat: MediaFormat;
  options: CompressOptions;
}

export interface CompressSuccess {
  id: number;
  ok: true;
  bytes: Uint8Array;
  format: OutputFormat;
  /** The encoded size, which is the resized size when a cap applied. */
  width: number;
  height: number;
}

export interface CompressFailure {
  id: number;
  ok: false;
  message: string;
}

export type CompressResponse = CompressSuccess | CompressFailure;

/** The MIME type for an output format, including the one the engine cannot read. */
export function outputMimeType(format: OutputFormat): string {
  return format === 'avif' ? 'image/avif' : `image/${format}`;
}
