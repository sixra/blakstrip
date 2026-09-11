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
import { expect, test } from '@playwright/test';
import { SAMPLE_PHOTO } from '../support/fixtures';

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
  // SOI marker: proves a JPEG came back rather than an empty or truncated file,
  // which a bare length comparison would happily accept.
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
});

test('is reachable from the metadata tool once a photo is clean', async ({ page }) => {
  // Compression used to be a panel on that page. Removing it left this link as
  // the only route between the two, so a broken link silently strands anyone who
  // wanted both things done.
  await page.goto('/media-strip');
  await page.locator('input[type=file]').setInputFiles(SAMPLE_PHOTO);
  await page.getByRole('button', { name: /Remove all of it|Clean it anyway/ }).click();

  await page.getByRole('link', { name: 'Compress an image' }).click();
  await expect(page).toHaveURL(/\/image-compress$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Make it smaller');
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
