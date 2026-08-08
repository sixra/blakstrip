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

// The update path, asserted on the generated worker because the failure is silent
// and slow. `registerType: 'autoUpdate'` is documented as forcing skipWaiting and
// clientsClaim, and did not: the worker shipped with a `message` listener waiting
// to be told to skip, and no clientsClaim at all. A returning visitor installed
// the new worker, it sat in `waiting` behind the old one indefinitely, and they
// kept the previous build. For an installed PWA there was no way out short of
// closing every window of it.
//
// Nothing else can catch this. Every other test loads one build, so the second
// build is exactly the case never exercised. These two lines are cheap and they
// fail the moment the generated worker loses its ability to take over.
test('the service worker can take over from a previous version', async ({ request }) => {
  const sw = await (await request.get('/sw.js')).text();

  // The broken build *did* contain `self.skipWaiting()` — inside a `message`
  // listener, waiting to be told. So matching that call proves nothing, and an
  // earlier version of this test asserted it while claiming otherwise.
  //
  // What separates the two builds is the listener itself: waiting to be messaged
  // is the shape prompt-mode uses, and an auto-updating worker should activate on
  // its own instead. Its absence, plus clientsClaim (missing entirely before), is
  // what the broken output could not satisfy.
  expect(sw).not.toContain('SKIP_WAITING');
  expect(sw).toContain('self.skipWaiting()');
  expect(sw).toContain('clientsClaim()');

  // Without this the previous version's precache survives alongside the new one.
  expect(sw).toContain('cleanupOutdatedCaches');
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
