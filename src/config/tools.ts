/**
 * Every tool blakstrip ships, in one place.
 *
 * The nav, the hub grid, the sitemap priorities and the structured data all read
 * from here. Before this existed the list lived inline in `Header.astro` and
 * nowhere else, so adding a tool meant remembering four separate files and
 * missing one was silent: the page would exist, and simply never be linked or
 * described anywhere.
 *
 * Adding a tool is one entry plus one page under `src/pages`.
 */

export interface Tool {
  /** Route, without extension. `build.format: 'file'` serves `/foo.html` at `/foo`. */
  href: string;
  /** Short label for the header nav, where space is tight. */
  nav: string;
  /** Imperative name, used as the card heading and the CTA. */
  name: string;
  /** One line for the hub card. No full stop: it sits under a heading. */
  pitch: string;
  /** The page's meta description and its WebApplication description. */
  description: string;
  /** `@id` fragment for this tool's WebApplication entity. */
  entityId: string;
  /** Fragment shown in the browser tab and search results. */
  title: string;
}

export const TOOLS: readonly Tool[] = [
  {
    href: '/pdf-redact',
    nav: 'PDF',
    name: 'Redact a PDF',
    pitch: 'Remove text and hidden data for good, instead of covering it with a box',
    description:
      'Drop in a PDF and redact it in your browser. Draw boxes or search a term to remove every match for good, strip metadata, and verify before download.',
    entityId: 'https://blakstrip.com/#pdf-redact',
    title: 'Redact a PDF Online, Free and Private · blakstrip',
  },
  {
    href: '/media-strip',
    nav: 'Photos',
    name: 'Strip a photo',
    pitch: 'See what a picture is carrying about you, then remove it without touching the image',
    description:
      'Drop in a photo and see what it is carrying: GPS location, camera serial, timestamps, hidden preview images. Remove it all in your browser without touching the picture itself, then optionally shrink the file.',
    entityId: 'https://blakstrip.com/#media-strip',
    title: 'Remove Photo Metadata Online, Free and Private · blakstrip',
  },
];

/** The tool serving a given path, for `aria-current` and per-page metadata. */
export function toolFor(pathname: string): Tool | undefined {
  const path = pathname.replace(/\.html$/, '');
  return TOOLS.find((tool) => tool.href === path);
}

const SITE = 'https://blakstrip.com';

/**
 * This tool's `WebApplication` entity, ready to serialise.
 *
 * Each tool gets its own `@id` and points back at the one `WebSite`. All three
 * pages used to share `@id: /#app`, which said the photo tool and the PDF
 * redactor were the same program: harmless while there was one of them, wrong
 * the moment there were two.
 */
export function toolSchema(tool: Tool): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    '@id': tool.entityId,
    name: `blakstrip · ${tool.name.toLowerCase()}`,
    url: `${SITE}${tool.href}`,
    description: tool.description,
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Any modern web browser',
    browserRequirements: 'Requires JavaScript',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    isPartOf: { '@type': 'WebSite', '@id': `${SITE}/#website` },
    creator: { '@type': 'Organization', name: 'sixra.dev', url: 'https://sixra.dev' },
  };
}
