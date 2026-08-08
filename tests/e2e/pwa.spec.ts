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

// How an update reaches someone who already has the site installed. This is the
// path that shipped broken: the worker waited to be told to activate while the
// registration expected it to activate on its own, so it sat in `waiting` behind
// the old worker indefinitely and no existing user ever received an update.
//
// The site now uses prompt mode deliberately, because nothing here is persisted
// and an unannounced reload discards the document someone is redacting. The two
// halves have to agree: the worker waits, and the page decides when to tell it.
//
// Note what this cannot check. A broken autoUpdate build and a correct prompt
// build produce nearly identical bundles, both containing SKIP_WAITING and
// messageSkipWaiting. What separates them is whether the page supplies a handler
// that actually applies the update, so that is what is asserted.
test('the worker waits to be told, and the page is able to tell it', async ({ request }) => {
  const sw = await (await request.get('/sw.js')).text();

  // Waiting is correct here: it keeps the old build whole and consistent until the
  // visitor accepts, which also avoids serving new chunks to a page running old
  // code. A top-level self.skipWaiting() would mean the other mode.
  expect(sw).toContain('SKIP_WAITING');
  expect(sw).not.toMatch(/"use strict";\s*self\.skipWaiting\(\)/);

  // Still evicts the previous version's precache once activation does happen.
  expect(sw).toContain('cleanupOutdatedCaches');

  const html = await (await request.get('/')).text();
  const src = html.match(/src="(\/_astro\/Base\.astro[^"]*\.js)"/)?.[1];
  expect(src, 'the registration script should be a hashed module').toBeTruthy();
  const client = await (await request.get(src!)).text();

  // The page's own update handler. Its absence is what made the old pairing inert.
  expect(client).toContain('messageSkipWaiting');
  expect(client).toContain('A new version of blakstrip is ready');
});

test('the precached HTML is revisioned so a new build replaces it', async ({ request }) => {
  const sw = await (await request.get('/sw.js')).text();

  // Hashed assets carry `revision: null` because the filename is the revision.
  // The HTML routes are not hashed, so they need a content revision or workbox
  // would serve the first version it ever cached, forever.
  for (const route of ['/', 'pdf-redact', 'media-strip']) {
    expect(sw).toMatch(new RegExp(`url:"${route}",revision:"[0-9a-f]{32}"`));
  }
});
