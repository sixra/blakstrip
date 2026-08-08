import { describe, expect, it } from 'vitest';
import {
  compressedFileName,
  fitWithin,
  optionsForPreset,
  outputMimeType,
  percentSaved,
  type CompressPreset,
} from './compress';

describe('fitWithin', () => {
  it('leaves an image alone when no cap is given', () => {
    expect(fitWithin({ width: 4000, height: 3000 })).toEqual({ width: 4000, height: 3000 });
  });

  it('scales the longest side down to the cap and keeps the aspect ratio', () => {
    expect(fitWithin({ width: 4000, height: 3000 }, 2000)).toEqual({ width: 2000, height: 1500 });
  });

  it('caps the height when the image is taller than it is wide', () => {
    expect(fitWithin({ width: 3000, height: 4000 }, 2000)).toEqual({ width: 1500, height: 2000 });
  });

  it('never enlarges an image that already fits', () => {
    // The case that reads backwards: "fit within 2000" sounds like an
    // instruction to make it 2000, and upscaling would hand back a blurrier and
    // bigger file than the one that came in.
    expect(fitWithin({ width: 400, height: 300 }, 2000)).toEqual({ width: 400, height: 300 });
  });

  it('returns a copy rather than the caller’s own object', () => {
    const source = { width: 100, height: 50 };
    const result = fitWithin(source, 500);
    expect(result).not.toBe(source);
  });

  it('keeps an extreme aspect ratio at one pixel instead of rounding to zero', () => {
    // A zero-sided canvas throws rather than degrading, so this is the
    // difference between a squashed thumbnail and a crash. Both sides are
    // checked: a clamp on only one of them passes a test that tries only the
    // other, which is how the missing one stayed missing.
    expect(fitWithin({ width: 10_000, height: 3 }, 100)).toEqual({ width: 100, height: 1 });
    expect(fitWithin({ width: 3, height: 10_000 }, 100)).toEqual({ width: 1, height: 100 });
  });
});

describe('optionsForPreset', () => {
  it('converts to WebP for the smallest preset whatever came in', () => {
    for (const source of ['jpeg', 'png', 'webp'] as const) {
      expect(optionsForPreset('smallest', source).format).toBe('webp');
    }
  });

  it('keeps the source format for the presets that are not chasing size', () => {
    for (const preset of ['balanced', 'best'] as const) {
      for (const source of ['jpeg', 'png', 'webp'] as const) {
        expect(optionsForPreset(preset, source).format).toBe(source);
      }
    }
  });

  it('raises quality from smallest to balanced to best', () => {
    const quality = (preset: CompressPreset): number => optionsForPreset(preset, 'jpeg').quality;
    expect(quality('smallest')).toBeLessThan(quality('balanced'));
    expect(quality('balanced')).toBeLessThan(quality('best'));
  });

  it('caps dimensions only for the smallest preset', () => {
    expect(optionsForPreset('smallest', 'jpeg').maxDimension).toBe(2048);
    expect(optionsForPreset('balanced', 'jpeg').maxDimension).toBeUndefined();
    expect(optionsForPreset('best', 'jpeg').maxDimension).toBeUndefined();
  });

  it('stays inside the range each codec accepts', () => {
    for (const preset of ['smallest', 'balanced', 'best'] as const) {
      const options = optionsForPreset(preset, 'png');
      expect(options.quality).toBeGreaterThanOrEqual(1);
      expect(options.quality).toBeLessThanOrEqual(100);
      // OxiPNG rejects a level outside 0..6.
      expect(options.effort).toBeGreaterThanOrEqual(0);
      expect(options.effort).toBeLessThanOrEqual(6);
    }
  });
});

describe('compressedFileName', () => {
  it('replaces the extension when the format changed', () => {
    expect(compressedFileName('holiday.png', 'webp')).toBe('holiday-small.webp');
  });

  it('writes jpg rather than jpeg, which is what everything else produces', () => {
    expect(compressedFileName('photo.heic', 'jpeg')).toBe('photo-small.jpg');
  });

  it('keeps dots that are part of the name', () => {
    expect(compressedFileName('holiday.2024.summer.jpg', 'jpeg')).toBe(
      'holiday.2024.summer-small.jpg'
    );
  });

  it('adds an extension to a name that has none', () => {
    expect(compressedFileName('scan', 'png')).toBe('scan-small.png');
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    // `.gitignore` has no extension: slicing at the dot would leave an empty stem
    // and a download called `-small.png`.
    expect(compressedFileName('.hidden', 'png')).toBe('.hidden-small.png');
  });
});

describe('percentSaved', () => {
  it('reports the reduction as a whole percentage', () => {
    expect(percentSaved(1000, 250)).toBe(75);
  });

  it('goes negative when the output grew', () => {
    // Re-encoding an already-optimised JPEG genuinely does this, and clamping it
    // to zero would show "0% saved" for a file that got bigger.
    expect(percentSaved(1000, 1200)).toBe(-20);
  });

  it('is zero when nothing changed', () => {
    expect(percentSaved(1000, 1000)).toBe(0);
  });

  it('does not divide by zero on an empty input', () => {
    expect(percentSaved(0, 100)).toBe(0);
  });
});

describe('outputMimeType', () => {
  it('maps every output format, including the one the engine cannot read', () => {
    expect(outputMimeType('jpeg')).toBe('image/jpeg');
    expect(outputMimeType('png')).toBe('image/png');
    expect(outputMimeType('webp')).toBe('image/webp');
    // AVIF is absent from MediaFormat on purpose, so it cannot go through the
    // engine's own MIME map. Getting this wrong hands the OS a file it opens
    // with the wrong application.
    expect(outputMimeType('avif')).toBe('image/avif');
  });
});

describe('compressedFileName for AVIF', () => {
  it('replaces the extension rather than appending one', () => {
    expect(compressedFileName('holiday.jpg', 'avif')).toBe('holiday-small.avif');
  });
});
