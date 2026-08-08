import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { RedactorPage } from './pages/RedactorPage';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

for (const path of ['/', '/pdf-redact', '/media-strip']) {
  test(`no accessibility violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations).toEqual([]);
  });
}

test('no accessibility violations with a document loaded', async ({ page }) => {
  // Scans the state the empty-page checks miss: the role="application" overlay,
  // the audit panel (screen-reader severity text), the toolbar and thumbnails.
  const redactor = new RedactorPage(page);
  await redactor.goto();
  await redactor.uploadTextFixture();
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations).toEqual([]);
});

test('no accessibility violations with a photo stripped and compressed', async ({ page }) => {
  // The compression panel had never been scanned by anything. It is the newest
  // and densest UI in the app (a preset group, a select, range inputs with hint
  // text, a live region and a colour-coded verdict) and every empty-page scan
  // above stops at the drop zone, so none of it was ever looked at.
  const photo = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 40, g: 90, b: 140 } },
  })
    .jpeg({ quality: 95 })
    .toBuffer();

  await page.goto('/media-strip');
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'holiday.jpg', mimeType: 'image/jpeg', buffer: photo });
  await page.getByRole('button', { name: /Remove all of it|Clean it anyway/ }).click();

  // Waiting for the download button is waiting for a codec to have finished, so
  // the panel is scanned fully populated rather than mid-spinner.
  await expect(page.getByRole('button', { name: 'Download the smaller file' })).toBeVisible({
    timeout: 60_000,
  });

  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations).toEqual([]);
});

test('the verify dialog traps focus and restores it on close', async ({ page }) => {
  // axe cannot see either of these: a trap that leaks and focus that never comes
  // back are both invisible to a static scan, so they need a keyboard assertion.
  const redactor = new RedactorPage(page);
  await redactor.goto();
  await redactor.uploadTextFixture();
  await redactor.drawBoxByKeyboard();
  await redactor.export();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Returns a description of the focused element when it is a control *behind*
  // the modal, which is the actual failure mode. `document.body` is allowed: it is
  // where Chromium parks focus between the dialog and the browser's own chrome,
  // and no page control is reachable from there while the background is inert.
  const escapedControl = (): Promise<string | null> =>
    page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body || a.closest('dialog')) return null;
      return (a as HTMLElement).outerHTML.slice(0, 80);
    });

  // Backwards from the first control is where the previous hand-rolled trap
  // leaked, landing on the "Next" page button behind the dialog.
  await page.keyboard.press('Shift+Tab');
  expect(await escapedControl()).toBeNull();
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    expect(await escapedControl()).toBeNull();
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Export' })).toBeFocused();
});

test('no accessibility violations with the verify dialog open', async ({ page }) => {
  const redactor = new RedactorPage(page);
  await redactor.goto();
  await redactor.uploadTextFixture();
  await redactor.drawBoxByKeyboard();
  await redactor.export();
  await expect(page.getByRole('dialog')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations).toEqual([]);
});
