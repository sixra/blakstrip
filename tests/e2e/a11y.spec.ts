import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { RedactorPage } from './pages/RedactorPage';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

for (const path of ['/', '/pdf-redact']) {
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
