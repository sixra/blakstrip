import { expect, test } from '@playwright/test';
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
  await expect(dialog).toContainText('No text, metadata, attachments, or scripts are recoverable', {
    timeout: 15_000,
  });
});
