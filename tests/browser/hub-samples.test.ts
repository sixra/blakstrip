/**
 * What each preset actually does to the hub's sample photo.
 *
 * The hub card for the compressor quotes these numbers. The other two cards run
 * their engine in Node while the page is built, but this one cannot: the encode
 * path decodes through `createImageBitmap` and an `OffscreenCanvas`, and neither
 * exists outside a browser. So the sizes are measured here, by the real codecs,
 * and written to a JSON the page imports at build time.
 *
 * It is a file snapshot rather than an assertion because there is no right
 * answer to assert: the point is that the card cannot quote a number no encoder
 * produced. A codec change moves these and turns this test red, which is the
 * intended alarm; regenerate deliberately with
 *
 *   pnpm exec vitest run --project browser -u tests/browser/hub-samples.test.ts
 *
 * and commit the result. Expect that to be needed after a Playwright bump too:
 * the pixels come from Chromium's decoder, so a new Chromium can shift the
 * output by a few bytes without anything in this repo changing.
 */
import { expect, it } from 'vitest';
import samplePhoto from '../../src/assets/samples/sample-photo.jpg?bytes';
import { optionsForPreset, PRESETS } from '../../src/lib/media/compress';
import { Compressor } from '../../src/lib/media/compressor';

it('records what each preset does to the hub sample photo', async () => {
  const source = new Uint8Array(samplePhoto());
  const compressor = new Compressor();
  const presets = [];

  try {
    // Sequential, not in parallel: the compressor abandons any job still in
    // flight when a new one arrives, so three concurrent calls would leave two
    // of them rejected with SupersededError.
    for (const { id } of PRESETS) {
      const result = await compressor.compress(source, 'jpeg', optionsForPreset(id, 'jpeg'));
      presets.push({
        preset: id,
        bytes: result.bytes.length,
        format: result.format,
        width: result.width,
        height: result.height,
      });
    }
  } finally {
    compressor.dispose();
  }

  // Every preset must earn the card: one that grew the file would be a real
  // result, but not one worth advertising, and it would mean the sample photo
  // needs regenerating rather than the card needs rewording.
  for (const entry of presets) {
    expect(entry.bytes, `${entry.preset} did not shrink the file`).toBeLessThan(source.length);
  }

  // Decoded, not taken from an output: a compressed result reports the size it
  // was encoded at, and "smallest" caps the longest side, so a sample above that
  // cap would have the hub quote the capped size as the original's.
  const bitmap = await createImageBitmap(new Blob([source], { type: 'image/jpeg' }));
  const record = {
    source: { bytes: source.length, width: bitmap.width, height: bitmap.height },
    presets,
  };
  bitmap.close();
  await expect(`${JSON.stringify(record, null, 2)}\n`).toMatchFileSnapshot(
    '../../src/assets/samples/sample-photo.compressed.json'
  );
}, 120_000);
