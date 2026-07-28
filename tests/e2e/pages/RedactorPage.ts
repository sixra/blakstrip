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

  /** Load the text-secrets fixture and wait for the first page to render. */
  async uploadTextFixture(): Promise<void> {
    await this.page.locator('input[type=file]').setInputFiles(TEXT_FIXTURE);
    await expect(this.overlay).toHaveAttribute('data-page-ready', 'true');
  }

  /** Draw a redaction rectangle inside the rendered page. */
  async drawBox(): Promise<void> {
    // The canvas is tall and can sit below the fold; raw mouse.move does not
    // auto-scroll, so bring the overlay's top into view and draw near it.
    await this.overlay.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const box = await this.overlay.boundingBox();
    if (!box) throw new Error('overlay has no bounding box');
    const x = box.x + box.width * 0.25;
    const y = box.y + 40;
    await this.page.mouse.move(x, y);
    await this.page.mouse.down();
    await this.page.mouse.move(x + 140, y + 30, { steps: 6 });
    await this.page.mouse.up();
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

  async export(): Promise<void> {
    await this.page.getByRole('button', { name: 'Export' }).click();
  }
}
