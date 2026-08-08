/**
 * Head metadata, asserted against the built HTML.
 *
 * This existed as a gap: the a11y suite scans every route and the no-egress suite
 * watches the network, but nothing looked at `<head>`. So when the site grew a
 * second tool, the social card kept describing it as a PDF redactor on every page
 * and every test stayed green.
 *
 * Fetched rather than rendered: these are static tags, so a browser adds nothing.
 */
import { expect, test } from '@playwright/test';
import { TOOLS } from '../../src/config/tools';

const attr = (html: string, selector: string): string | undefined =>
  html.match(new RegExp(`<meta[^>]*${selector}[^>]*content="([^"]*)"`))?.[1];

const ROUTES = ['/', ...TOOLS.map((tool) => tool.href)];

/** Only the fields these tests assert on; `JSON.parse` is otherwise `any`. */
interface JsonLd {
  '@type'?: string;
  '@id'?: string;
  isPartOf?: { '@id'?: string };
  hasPart?: { '@id'?: string }[];
}

const jsonLd = (html: string): JsonLd =>
  JSON.parse(
    html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)?.[1] ?? '{}'
  ) as JsonLd;

for (const route of ROUTES) {
  test(`${route} describes itself without naming the wrong tool`, async ({ request }) => {
    const html = await (await request.get(route)).text();

    // The regression this file exists for. "PDF redactor" is true of one page and
    // was being asserted on all three, in the alt text of the shared social card.
    const imageAlt = attr(html, 'property="og:image:alt"');
    expect(imageAlt).toBeTruthy();
    if (route !== '/pdf-redact') {
      expect(imageAlt?.toLowerCase()).not.toContain('pdf');
    }
    expect(attr(html, 'name="twitter:image:alt"')).toBe(imageAlt);

    // Every page states its own description; none may fall back to the default.
    const description = attr(html, 'name="description"');
    expect(description).toBeTruthy();
    expect(attr(html, 'property="og:description"')).toBe(description);
    expect(attr(html, 'name="twitter:description"')).toBe(description);

    // `build.format: 'file'` serves /foo.html at /foo, so the canonical must carry
    // neither the suffix nor a trailing slash, or every page has two addresses.
    const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
    expect(canonical).toBe(`https://blakstrip.com${route === '/' ? '/' : route}`);
    expect(canonical).not.toMatch(/\.html$/);
  });
}

test('each tool page declares its own application entity, not a shared one', async ({
  request,
}) => {
  // All three pages used to share `@id: /#app`, which asserted that the photo tool
  // and the PDF redactor were the same program.
  //
  // Uniqueness is checked against the registry rather than the rendered pages: a
  // duplicated `entityId` is a typo in one file, and pairing it with the per-page
  // assertion below covers the same ground without needing a fetch to notice.
  expect(new Set(TOOLS.map((tool) => tool.entityId)).size).toBe(TOOLS.length);

  for (const tool of TOOLS) {
    const schema = jsonLd(await (await request.get(tool.href)).text());
    expect(schema['@type']).toBe('WebApplication');
    expect(schema['@id']).toBe(tool.entityId);
    expect(schema.isPartOf?.['@id']).toBe('https://blakstrip.com/#website');
  }
});

test('the hub declares the website and lists every tool as a part', async ({ request }) => {
  const schema = jsonLd(await (await request.get('/')).text());

  expect(schema['@type']).toBe('WebSite');
  // Built from the registry, so a tool added without a hub entry fails here.
  expect(schema.hasPart?.map((part) => part['@id'])).toEqual(TOOLS.map((tool) => tool.entityId));
});
