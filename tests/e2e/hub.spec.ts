/**
 * The hub's structure and its claims.
 *
 * The cards' contents are generated from the registry and from real engine
 * output, so what needs pinning here is the shape around them: that the page
 * says what the tools do before it promises what they will not, that each card
 * is one link named by its tool rather than a paragraph, and that the whole card
 * stays clickable once only its heading holds the anchor.
 */
import { expect, test } from '@playwright/test';
import { TOOLS } from '../../src/config/tools';

test('the hero names every tool before it makes a promise', async ({ page }) => {
  await page.goto('/');
  const hero = page.locator('main > div').first();

  // The page used to open on "Nothing leaves your device", which is the
  // guarantee. A stranger needs the job first.
  await expect(hero).toContainText('Redact PDFs');
  await expect(hero).toContainText('Strip photo metadata');
  await expect(hero).toContainText('Compress images');

  const heroText = (await hero.innerText()).replace(/\s+/g, ' ');
  expect(heroText.indexOf('Redact PDFs')).toBeLessThan(heroText.indexOf('Nothing leaves'));
});

test('each card link is named by its tool alone', async ({ page }) => {
  await page.goto('/');

  for (const tool of TOOLS) {
    // The card carries a heading, a pitch, a meta line and five rows of
    // evidence. Without an explicit label the link is named by all of it, and a
    // screen reader's link list reads as three paragraphs.
    const card = page.locator(`main a[href="${tool.href}"]`);
    await expect(card).toHaveAccessibleName(tool.name);
  }
});

test('the whole card is clickable, not just its heading', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('main a[href="/pdf-redact"]');
  const box = await card.boundingBox();
  expect(box).not.toBeNull();

  // Bottom-left of the card: inside it, far from the heading. Clicked through
  // the locator rather than by page coordinate, because the card sits below the
  // fold and raw mouse coordinates are viewport-relative, so they would land on
  // nothing and pass for the wrong reason.
  await card.click({ position: { x: 24, y: box!.height - 16 } });
  await expect(page).toHaveURL(/\/pdf-redact$/);
});

test('the card shows its evidence in full', async ({ page }) => {
  // The caption under the cards calls these real results, so a clipped value
  // undercuts the claim. The layout used to truncate the right-hand column at
  // widths where the card was never wide enough to hold it.
  await page.goto('/');
  const value = page.locator('main a[href="/media-strip"] li').first();
  await expect(value).toContainText('51.50897, -0.12879');

  const clipped = await value.evaluate((el) =>
    [...el.querySelectorAll('span')].some((s) => s.scrollWidth > s.clientWidth + 1)
  );
  expect(clipped, 'a value is cut off by its own box').toBe(false);
});

test('the heading outline is one h1, then sections, then cards', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveCount(1);
  // Two sections (the tools and the verification argument) and one card each.
  await expect(page.locator('h2')).toHaveCount(2);
  await expect(page.locator('h3')).toHaveCount(TOOLS.length);
});
