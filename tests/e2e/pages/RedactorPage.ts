import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';

const TEXT_FIXTURE = fileURLToPath(
  new URL('../../../src/lib/pdf/__fixtures__/text-secrets.pdf', import.meta.url)
);

/** Page Object for /pdf-redact. */
export class RedactorPage {
  readonly page: Page;
  readonly overlay: Locator;

  constructor(page: Page) {
    this.page = page;
    this.overlay = page.getByTestId('redact-overlay');
  }

  async goto(): Promise<void> {
    await this.page.goto('/pdf-redact');
  }

  /** Load the text-secrets fixture and wait for the viewer to settle. */
  async uploadTextFixture(): Promise<void> {
    await this.page.locator('input[type=file]').setInputFiles(TEXT_FIXTURE);
    await expect(this.overlay).toHaveAttribute('data-page-ready', 'true');
    // Thumbnails are appended one at a time and re-lay-out the viewer, so waiting
    // on the page render alone leaves a later append free to shift the overlay
    // between measuring it and dragging on it. The fixture has two pages.
    await expect(this.page.getByRole('img', { name: /^Page \d+$/ })).toHaveCount(2);
  }

  /** Draw a redaction rectangle inside the rendered page. */
  async drawBox(): Promise<void> {
    // The canvas is tall and can sit below the fold; raw mouse.move does not
    // auto-scroll, so bring the overlay's top into view and draw near it.
    await this.overlay.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const box = await this.stableOverlayBox();
    const x = box.x + box.width * 0.25;
    // The fixture's first text line sits ~9% down the page; 12% lands the drag on
    // actual glyphs rather than the top margin, so "1 redaction" means something.
    const y = box.y + box.height * 0.12;
    await this.page.mouse.move(x, y);
    await this.page.mouse.down();
    await this.page.mouse.move(x + 140, y + 30, { steps: 6 });
    await this.page.mouse.up();
  }

  /** The overlay's box, re-read until two consecutive reads agree. */
  private async stableOverlayBox(): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  }> {
    let previous = await this.overlay.boundingBox();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await this.page.waitForTimeout(50);
      const current = await this.overlay.boundingBox();
      if (previous && current && current.x === previous.x && current.y === previous.y) {
        return current;
      }
      previous = current;
    }
    throw new Error('overlay geometry never settled');
  }

  /** Author a redaction box using only the keyboard (Enter, arrows, Enter). */
  async drawBoxByKeyboard(): Promise<void> {
    await this.overlay.focus();
    await this.page.keyboard.press('Enter'); // start a box at page center
    await this.page.keyboard.press('ArrowRight'); // move
    await this.page.keyboard.press('ArrowDown');
    await this.page.keyboard.press('Shift+ArrowRight'); // grow width
    await this.page.keyboard.press('Enter'); // place it
  }

  /**
   * Redact every occurrence of a term. Unlike drawBox this provably lands on the
   * text, so a downstream assertion about that text means something.
   */
  async redactAllMatching(term: string): Promise<void> {
    await this.page.getByRole('searchbox', { name: 'Find text to redact' }).fill(term);
    await this.page.getByRole('button', { name: 'Find' }).click();
    await this.page.getByRole('button', { name: /^Redact all \d+$/ }).click();
  }

  async export(): Promise<void> {
    await this.page.getByRole('button', { name: 'Export' }).click();
  }

  /** Confirm the verify dialog and return the bytes the browser actually saved. */
  async downloadFromDialog(): Promise<Uint8Array> {
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const [download] = await Promise.all([
      this.page.waitForEvent('download'),
      dialog.getByRole('button', { name: /^Download/ }).click(),
    ]);
    const path = await download.path();
    return new Uint8Array(await readFile(path));
  }
}
