import { expect, test } from '@playwright/test';

// The offline promise is load-bearing marketing ("turn off your wifi and it still
// works"), and it hinges on one glob extension. pdf.js ships its worker as .mjs, so
// a globPatterns list without `mjs` produces a PWA that installs and renders but
// cannot open a PDF. That failure is invisible until someone actually goes offline,
// hence this assertion against the generated manifest.
test('the service worker precaches the pdf.js worker', async ({ request }) => {
  const sw = await (await request.get('/sw.js')).text();
  expect(sw).toContain('pdf.worker');
});
