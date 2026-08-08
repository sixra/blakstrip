# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-08-08

blakstrip is now two tools. Photos join PDFs: see what a picture is carrying, remove it without
touching a single pixel, and check the result. The home page became a hub, and the redactor moved to
its own page at `/pdf-redact`.

### Added

- **Photos**: a second tool at `/media-strip`. It audits a JPEG, PNG or WebP for what it is carrying
  (GPS location, camera make and serial, timestamps, hidden preview images, XMP and IPTC), strips it
  losslessly by rewriting the container so the image is never re-encoded, then re-inspects its own
  output and shows you the result. Same audit, strip, verify shape the redactor uses.
- **Photos**: optional compression, in the browser, through MozJPEG, libwebp, OxiPNG and AVIF. Three
  presets, an effort dial, a dimension cap, and a full-size before-and-after view you can pan to
  look for artefacts. Every codec is inlined into the worker as wasm, so nothing is ever fetched
  and `connect-src 'none'` still holds while they run.
- **Site**: `/` is a hub for both tools, each tool has a page that explains it, and a tools registry
  feeds the nav, the hub, the sitemap and the structured data from one list.
- **Security headers**: HSTS, `Cross-Origin-Opener-Policy`, a deny-by-default `Permissions-Policy`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options` and `nosniff`.
- **PDF redactor**: export progress (`page n of m`, then verifying) and a yield between pages, so a
  long export no longer looks like a frozen tab.
- **PDF redactor**: export with no redactions, for cleaning metadata alone.
- **PDF redactor**: text that a box covered on its own page but that is still readable elsewhere is
  reported as its own category, naming the pages, rather than as an undifferentiated leak.
- A response-header CSP over `/_astro/*` and `/sw.js`, so the no-egress guarantee reaches the worker
  that parses the document rather than only the page.
- A `Limitations` section in the README and SECURITY.md covering EXIF inside images, layered PDFs
  and encrypted files.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `RELEASING.md`, issue and PR templates, and Dependabot.

### Changed

- **Breaking**: `/` no longer opens the PDF redactor. It is a hub for both tools, and the redactor
  lives at `/pdf-redact`. A bookmark to the old home page still resolves, but lands on the hub.
- **Structured data**: each tool has its own `WebApplication` entity pointing back at one `WebSite`.
  All pages previously shared a single `@id`, which asserted that the photo tool and the redactor
  were the same program.
- **PDF redactor**: the verify dialog is a native `<dialog>`; the previous hand-rolled focus trap
  leaked out of the modal on the first Shift+Tab. The download button now reads "Download anyway"
  when the output is not clean, and SECURITY.md no longer claims the download is blocked.
- **PDF redactor**: async status (opening, searching, matches, export, errors) is announced to
  screen readers.
- **PDF redactor**: the pdf writer loads only once a document is open, roughly halving the
  first-load JavaScript.
- CI pins actions to commit SHAs, runs with `contents: read`, and caches Playwright browsers.
- `_headers` now sets caching as well as security: a year on the content-hashed `/_astro/*` assets
  (which is where the ~1.3 MB pdf.js worker lives) and always-revalidate on `/sw.js`, whose precache
  manifest would otherwise pin an entire stale build offline.
- Tooling configs are inlined into the repo and the `@sixra/devkit` dependency is gone, so the build
  depends on nothing outside this repository.
- The toolchain moved to Node 24.

### Fixed

- **Installed apps could never update.** The service worker waited forever behind the old one, so
  anyone who installed the app stayed on the version they installed. A new worker now takes over,
  and a page holding an open file asks before it reloads rather than discarding your work.
- **Offline actually works.** The pdf.js worker ships as `.mjs` and was missing from the service
  worker's precache list, so the installed app rendered but could not open a PDF without a network.
- **Optional-content layers are no longer certified clean.** `/OCProperties` lives on the catalog
  and does not survive `copyPages`, so re-inspecting the export found nothing while the layer
  content itself remained on copied pages. Detection now looks for the layer objects.
- **A malformed PDF no longer blanks the audit.** A present-but-wrong-typed `/Type` made
  `inspectStructure` throw, and the panel simply did not render, showing no warnings on exactly the
  files most likely to be hiding something.
- The pixel-coverage backstop now fails closed on a raster mismatch, flags large-area leaks by
  absolute pixel count as well as by fraction, and counts light-grey ink as content.
- Vertical text runs are over-covered like right-to-left ones instead of being measured
  left-to-right.
- Hyperlinks are reported separately from annotations that can conceal content, and annotations
  written directly into a page's `/Annots` array are no longer missed.
- The page canvas re-fits when the viewport resizes instead of rendering distorted.
- Dropping an unsupported file gives a reason instead of doing nothing.
- The header wordmark is no longer encoded lossily, which was leaving the logo visibly blurred.

## [1.0.0] - 2026-07-30

First stable release. blakstrip redacts PDFs entirely in the browser: redacted pages are rasterized
so removed content is gone rather than covered, hidden metadata is stripped, and the output is
re-verified before you can download it. No file ever leaves your device.

### Added

- **Rasterizing redaction**: pages you redact are flattened to an image with the black boxes burned
  into the pixels, so the underlying text and vectors are removed rather than hidden. Untouched
  pages are copied verbatim and keep selectable text.
- **Audit on load**: enumerates leak vectors (metadata, XMP, annotations, form values, attachments,
  embedded JavaScript) and flags scanned pages.
- **Verify on export**: re-opens the output and checks for recoverable text, surviving structure,
  and a pixel-coverage backstop before allowing the download.
- **Metadata stripping**: clears document and embedded metadata, then mark-sweep garbage-collects
  the orphaned objects.
- **No network egress**: a strict `connect-src 'none'` Content-Security-Policy in production, plus
  offline PWA support.

<!-- On release, update these refs and add the new version. See RELEASING.md. -->

[Unreleased]: https://github.com/sixra/blakstrip/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/sixra/blakstrip/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/sixra/blakstrip/releases/tag/v1.0.0
