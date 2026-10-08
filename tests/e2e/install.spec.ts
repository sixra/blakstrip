import { expect, test, type Page } from '@playwright/test';

// What Safari sends on a Mac, and on an iPad since iPadOS 13, which asks for the
// desktop site. Only the touch points tell the two apart.
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

async function openAsSafari(page: Page, touchPoints: number): Promise<void> {
  await page.addInitScript((points) => {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => points });
    // Safari never fires this, and Chromium's own install button would win if it did.
    window.addEventListener('beforeinstallprompt', (e) => e.stopImmediatePropagation(), true);
  }, touchPoints);
  await page.goto('/');
}

test.use({ userAgent: MAC_SAFARI });

test('offers the Add to Home Screen hint on an iPad', async ({ page }) => {
  await openAsSafari(page, 5);
  await page.getByRole('button', { name: 'Install app' }).click();
  await expect(page.getByRole('note')).toContainText('Add to Home Screen');
});

test('offers no install hint on a Mac', async ({ page }) => {
  await openAsSafari(page, 0);
  // The island renders nothing here, so its absence only counts once it has mounted,
  // which is when Astro drops the `ssr` attribute.
  const island = page.locator('astro-island[component-url*="InstallButton"]');
  await expect(island).not.toHaveAttribute('ssr');
  await expect(page.getByRole('button', { name: 'Install app' })).toHaveCount(0);
});
