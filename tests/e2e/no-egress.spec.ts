/**
 * The claim the whole product rests on: nothing you open ever leaves the machine.
 *
 * It was enforced by CSP and verified by nobody. `connect-src 'none'` is a
 * runtime control that only bites in production, so a change that introduces a
 * fetch passes every other test in this repo and fails silently for users, or
 * worse, succeeds. These tests watch the network directly while each tool does
 * its real work.
 *
 * They run against the production build, which is the only place the strict CSP
 * and the built worker both exist.
 */
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Request } from '@playwright/test';
import sharp from 'sharp';

const PDF_FIXTURE = fileURLToPath(
  new URL('../../src/lib/pdf/__fixtures__/text-secrets.pdf', import.meta.url)
);

/**
 * Requests to anywhere other than the site itself.
 *
 * The origin comes from the configured base URL rather than from `page.url()`:
 * the first request of a navigation fires while the page is still `about:blank`,
 * whose origin is `null`, which made every request look like egress.
 */
function offsiteRequests(
  page: Page,
  siteUrl: string
): { requests: Request[]; violations: string[] } {
  const requests: Request[] = [];
  const violations: string[] = [];
  const siteOrigin = new URL(siteUrl).origin;

  page.on('request', (request) => {
    const url = new URL(request.url());
    // Same-origin asset loads are the site working. data: and blob: are how
    // bytes reach a canvas or a download, so they are the tool operating
    // locally, not leaving.
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin !== siteOrigin) requests.push(request);
  });

  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to/i.test(text)) violations.push(text);
  });

  return { requests, violations };
}

function describeRequests(requests: Request[]): string[] {
  return requests.map((request) => `${request.method()} ${request.url()}`);
}

/** A real photo, encoded by sharp so the codecs have genuine image data to chew on. */
async function photoBytes(): Promise<Buffer> {
  return sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 40, g: 90, b: 140 },
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
}

test('stripping and compressing a photo sends nothing anywhere', async ({ page, baseURL }) => {
  const watcher = offsiteRequests(page, baseURL!);
  const wasmRequests: string[] = [];
  page.on('request', (request) => {
    // The codecs are inlined as base64. A request for a .wasm file means the
    // inlining regressed and the glue fell back to fetching, which is exactly the
    // failure that would otherwise only show up as a broken production deploy.
    if (new URL(request.url()).pathname.endsWith('.wasm')) wasmRequests.push(request.url());
  });

  await page.goto('/media-strip');
  await page.locator('input[type=file]').setInputFiles({
    name: 'holiday.jpg',
    mimeType: 'image/jpeg',
    buffer: await photoBytes(),
  });

  await page.getByRole('button', { name: /Remove all of it|Clean it anyway/ }).click();
  await expect(page.getByRole('button', { name: 'Download the clean file' })).toBeVisible();

  // Compression starts on its own once the panel appears, so waiting for the
  // download button is waiting for a codec to have actually run.
  await expect(page.getByRole('button', { name: 'Download the smaller file' })).toBeVisible({
    timeout: 60_000,
  });

  expect(describeRequests(watcher.requests)).toEqual([]);
  expect(watcher.violations).toEqual([]);
  expect(wasmRequests).toEqual([]);
});

test('the compressed result is genuinely smaller, produced under the real CSP', async ({
  page,
}) => {
  // Same journey as above, asserting the outcome rather than the silence. If the
  // codecs could not compile under the production policy this is where it shows,
  // because the panel would sit on its error instead of reporting a saving.
  await page.goto('/media-strip');
  await page.locator('input[type=file]').setInputFiles({
    name: 'holiday.jpg',
    mimeType: 'image/jpeg',
    buffer: await photoBytes(),
  });

  await page.getByRole('button', { name: /Remove all of it|Clean it anyway/ }).click();
  await expect(page.getByRole('button', { name: 'Download the smaller file' })).toBeVisible({
    timeout: 60_000,
  });

  // Scoped to the panel: the strip has its own live region on the same page.
  const compression = page.locator('section[aria-label="Compression"]');
  await expect(compression.getByRole('status')).toContainText(/percent smaller/, {
    timeout: 60_000,
  });
  await expect(page.getByText('Re-read the compressed file')).toBeVisible();
});

test('redacting a PDF sends nothing anywhere', async ({ page, baseURL }) => {
  const watcher = offsiteRequests(page, baseURL!);

  await page.goto('/pdf-redact');
  await page.locator('input[type=file]').setInputFiles(PDF_FIXTURE);
  await expect(page.getByRole('img', { name: /^Page \d+$/ })).toHaveCount(2);

  expect(describeRequests(watcher.requests)).toEqual([]);
  expect(watcher.violations).toEqual([]);
});

test('the home page loads nothing from anywhere else', async ({ page, baseURL }) => {
  const watcher = offsiteRequests(page, baseURL!);

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  expect(describeRequests(watcher.requests)).toEqual([]);
  expect(watcher.violations).toEqual([]);
});
