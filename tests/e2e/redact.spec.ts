import { expect, test } from '@playwright/test';
import { outputContains } from '../support/pdfbytes';
import { RedactorPage } from './pages/RedactorPage';

test('audits on load, redacts a box, and verifies a clean export', async ({ page }) => {
  const redactor = new RedactorPage(page);
  await redactor.goto();
  await redactor.uploadTextFixture();

  // Audit-on-load surfaces the fixture's metadata before any redaction.
  await expect(page.getByText(/hiding \d+ things/)).toBeVisible();

  // Draw a redaction box (the page-object waits for the page to render first).
  await redactor.drawBox();
  await expect(page.getByText('1 redaction')).toBeVisible();

  // Verify-on-export proves the output is clean.
  await redactor.export();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('No text, metadata, attachments, or scripts are recoverable');
});

test('the downloaded file no longer contains the redacted secret', async ({ page }) => {
  const redactor = new RedactorPage(page);
  await redactor.goto();
  await redactor.uploadTextFixture();

  // Search-redact-all, so the boxes provably sit on the secret rather than on
  // whatever happens to be at a hardcoded offset.
  await redactor.redactAllMatching('123-45-6789');
  await redactor.export();
  const bytes = await redactor.downloadFromDialog();

  // Positive controls first, so the absence assertions below cannot pass vacuously
  // on an empty or truncated download.
  expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
  expect(bytes.byteLength).toBeGreaterThan(10_000);
  expect(outputContains(bytes, '/Image')).toBe(true); // page 1 really was rasterized

  // Assert against the artifact itself, not against the app's own verdict: this
  // spec would still pass on a broken verifyExport, and that is the point.
  expect(outputContains(bytes, '123-45-6789')).toBe(false);
  // Same page, so rasterizing took it too.
  expect(outputContains(bytes, 'jane.author@example.com')).toBe(false);
});

test('re-fits the page when the viewport narrows', async ({ page }) => {
  const redactor = new RedactorPage(page);
  await redactor.goto();
  await redactor.uploadTextFixture();

  const canvas = page.locator('canvas');
  const size = (): Promise<{ w: number; h: number }> =>
    canvas.evaluate((c: HTMLCanvasElement) => ({
      w: parseInt(c.style.width, 10),
      h: parseInt(c.style.height, 10),
    }));
  const before = await size();

  await page.setViewportSize({ width: 700, height: 800 });
  // Without a re-render the canvas keeps its old inline width and `max-w-full`
  // squashes it, so this poll is what actually distinguishes the two behaviours.
  await expect.poll(async () => (await size()).w).toBeLessThan(before.w);

  const after = await size();
  expect(after.w / after.h).toBeCloseTo(before.w / before.h, 2); // not distorted
});

test('authors a redaction box with the keyboard', async ({ page }) => {
  const redactor = new RedactorPage(page);
  await redactor.goto();
  await redactor.uploadTextFixture();

  // No mouse: focus the overlay and drive it with Enter + arrow keys.
  await redactor.drawBoxByKeyboard();
  await expect(page.getByText('1 redaction')).toBeVisible();
});

test('a box dragged past the page edge stays on the page and verifies clean', async ({ page }) => {
  // Wide enough to leave room beside the page to release the pointer over.
  await page.setViewportSize({ width: 1600, height: 1000 });
  const redactor = new RedactorPage(page);
  await redactor.goto();
  await redactor.uploadTextFixture();

  // From the blank right of the first text line to well past the page's right edge.
  await redactor.dragAcross({ x: 0.6, y: 0.07 }, { x: 1.3, y: 0.13 });
  await expect(page.getByText('1 redaction')).toBeVisible();
  // The remove button sits on the box's corner, so its parent is the box itself.
  const box = await page
    .getByRole('button', { name: 'Remove redaction' })
    .locator('..')
    .boundingBox();
  const overlay = await redactor.overlay.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(overlay!.x + overlay!.width + 1);

  await redactor.export();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText("didn't fully cover");
});
