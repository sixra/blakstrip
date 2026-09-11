/**
 * The compressor, end to end, against the production build.
 *
 * The unit tests drive the `Compressor` directly and the panel has been scanned
 * for accessibility, but nothing had put a file through this page and read what
 * came out of the download. That is the only place the whole chain is visible at
 * once: the drop zone identifies the bytes, the worker compiles its inlined wasm
 * under the strict CSP, and the browser saves a file.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { formatBytes, percentSaved, PRESETS } from '../../src/lib/media/compress';
import { SAMPLE_PHOTO } from '../support/fixtures';

/** What `tests/browser/hub-samples.test.ts` measured, as the hub reads it. */
interface Measured {
  source: { bytes: number; width: number; height: number };
  presets: { preset: string; bytes: number; format: string }[];
}

// Read rather than imported: Playwright runs this through Node's loader, which
// wants an import attribute for JSON, while the page imports the same file
// through Vite, which does not.
const measured = async (): Promise<Measured> =>
  JSON.parse(
    await readFile(
      fileURLToPath(
        new URL('../../src/assets/samples/sample-photo.compressed.json', import.meta.url)
      ),
      'utf8'
    )
  ) as Measured;

test('compresses a dropped photo and downloads something smaller', async ({ page }) => {
  const source = await readFile(SAMPLE_PHOTO);

  await page.goto('/image-compress');
  await page.locator('input[type=file]').setInputFiles(SAMPLE_PHOTO);

  // Compression starts on its own once the panel mounts, so waiting for the
  // download button is waiting for a codec to have actually finished.
  const download = page.getByRole('button', { name: 'Download the smaller file' });
  await expect(download).toBeVisible({ timeout: 60_000 });

  // The panel re-reads its own output. Nothing survived, because encoding from
  // raw pixels leaves nowhere for the source's GPS and camera data to go.
  await expect(page.getByText('Re-read the compressed file')).toBeVisible();

  const [saved] = await Promise.all([page.waitForEvent('download'), download.click()]);

  // The balanced preset keeps the source format, so this should still be a JPEG
  // and it should be named for one: a WebP body behind a .jpg name is a file
  // some applications refuse to open.
  expect(saved.suggestedFilename()).toBe('sample-photo-small.jpg');

  const path = await saved.path();
  const bytes = await readFile(path);
  expect(bytes.length).toBeLessThan(source.length);
  // Start and end markers: a length comparison accepts an empty file, and a
  // truncated JPEG still begins with SOI.
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  expect([bytes.at(-2), bytes.at(-1)]).toEqual([0xff, 0xd9]);
});

test('is reachable from the metadata tool once a photo is clean', async ({ page }) => {
  // This link is the only route between the two tools, so losing it silently
  // strands anyone who wants both things done to one picture.
  await page.goto('/media-strip');
  await page.locator('input[type=file]').setInputFiles(SAMPLE_PHOTO);
  await page.getByRole('button', { name: /Remove all of it|Clean it anyway/ }).click();

  await page.getByRole('link', { name: 'Compress an image' }).click();
  await expect(page).toHaveURL(/\/image-compress$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Make it smaller');
});

test('the hub card quotes the measured sizes, not something near them', async ({ page }) => {
  // The card is the headline claim of this tool and the page says the numbers
  // are real. Nothing else reads them, so swapping the arguments to
  // `percentSaved`, or rendering the source size where an output belongs, would
  // ship a confidently wrong card with every other test still green.
  const compressed = await measured();
  await page.goto('/');
  // Scoped to main: the header nav links to the same route.
  const card = page.locator('main a[href="/image-compress"]');

  await expect(card).toContainText(
    `${compressed.source.width} × ${compressed.source.height} · ${formatBytes(compressed.source.bytes)}`
  );

  for (const { id, label } of PRESETS) {
    const row = compressed.presets.find((entry) => entry.preset === id);
    expect(row, `no measured row for the ${id} preset`).toBeDefined();
    const saved = percentSaved(compressed.source.bytes, row!.bytes);
    await expect(card).toContainText(
      `${label}${formatBytes(row!.bytes)} ${row!.format.toUpperCase()} · ${saved}% smaller`
    );
  }
});

test('refuses a file that is not an image it can decode', async ({ page }) => {
  await page.goto('/image-compress');
  await page.locator('input[type=file]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('this is not a picture'),
  });

  // The refusal names the formats rather than failing silently or handing the
  // bytes to a decoder that would throw somewhere less legible.
  await expect(page.getByText(/unsupported file/i)).toBeVisible();
});
