# blakstrip

[![CI](https://github.com/sixra/blakstrip/actions/workflows/ci.yml/badge.svg)](https://github.com/sixra/blakstrip/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Two in-browser privacy tools that remove what a file is carrying instead of hiding it. Files are
opened, cleaned and saved entirely on your device; nothing is uploaded.

- **[Redact a PDF](https://blakstrip.com/pdf-redact)** — black out text and it is erased from the
  page, not covered by a rectangle.
- **[Strip a photo](https://blakstrip.com/media-strip)** — remove GPS, camera serial, timestamps and
  hidden thumbnails without touching a pixel, then optionally re-compress.

Both audit the file on load, act on it, then re-read the _output_ and report what is still in it.

## How PDF redaction works

1. **Load.** The file is read into memory and rendered with pdf.js. No network; the original bytes
   are kept for pdf-lib.
2. **Audit.** `inspectStructure` enumerates leak vectors (metadata and timestamps, XMP, annotations,
   form values, attachments, embedded JavaScript, EXIF/GPS in embedded JPEGs, authoring page-piece
   data, optional-content layers, encryption) and a text-layer check flags scans.
3. **Redact.** Draw boxes, or search a term and redact every match. Rects are stored in normalized,
   resolution-independent coordinates.
4. **Export.** Redacted pages are rasterized: the black boxes are burned into the pixels, so the
   underlying text and vectors are gone. Untouched pages are copied verbatim and keep selectable
   text. `stripAll` then removes metadata, XMP, annotations, forms, JavaScript, and attachments and
   garbage-collects the orphaned objects.
5. **Verify.** The output is re-opened and re-inspected; the dialog lists any recoverable text or
   surviving structure before you confirm the download.

A strict Content-Security-Policy (`connect-src 'none'` in production) blocks network egress from the
page. A worker does not inherit the page's policy, so the same `connect-src 'none'` is delivered as
a response header on the pdf.js worker, which is where your file is actually parsed. The only
requests the app ever makes are same-origin loads of its own assets; your document is never among
them, which you can confirm in devtools. It works offline as a PWA.

## How photo stripping works

1. **Detect.** The format comes from the bytes, never the filename or the declared MIME type.
2. **Audit.** The container is walked (JPEG marker segments, PNG chunks, WebP RIFF chunks) and each
   one classified. EXIF is parsed far enough to show the values, so "GPS present" becomes the actual
   coordinates.
3. **Strip.** An allowlist decides what stays, so an unrecognised vendor segment is dropped rather
   than preserved. The image bitstream is copied byte for byte: nothing is re-encoded, so no quality
   is lost. Orientation is the one tag kept, because dropping it turns photos sideways.
4. **Compress (optional).** MozJPEG, libwebp and OxiPNG run in a worker, with their wasm inlined as
   base64 so no codec is ever fetched and `connect-src 'none'` stands.
5. **Verify.** The output is re-read from scratch and anything still in it is listed.

**Stack:** Astro 7 (static, `<meta>` CSP), Svelte 5 (runes) islands, pdf-lib (write/strip),
pdfjs-dist (render/text), jSquash codecs (wasm, inlined), Tailwind v4, `@vite-pwa/astro`,
TypeScript strict.

## Deploying

`pnpm build` emits a static site to `dist/`, so any static host will serve it. The target is
**Cloudflare Pages**, and one requirement is not optional: **the host must apply
`public/_headers`**. That file carries the things a `<meta>` CSP cannot express and that this app's
promises depend on:

- `frame-ancestors` / `X-Frame-Options`, the clickjacking defence, which is ignored in a `<meta>`
  policy;
- `Strict-Transport-Security`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-*`;
- the per-path `connect-src` over `/_astro/*` and `/sw.js`, which is what blocks network egress from
  the pdf.js worker where your document is parsed (a worker does not inherit the page's policy).

Deploy somewhere that ignores `_headers` and the app still works, but silently without any of the
above. If you fork and host it elsewhere, port those headers to your host's own mechanism, and check
how it combines rules that match the same path: the per-path `connect-src` is written to be
_additive_ to the site-wide policy. Cloudflare serves such a path two separate
`Content-Security-Policy` headers, and browsers enforce multiple CSP headers independently, so both
apply. A host that instead replaces the value would silently drop `frame-ancestors 'none'` from
those paths.

To check a deployment, `curl -I` a hashed asset and confirm you get two `content-security-policy`
lines plus the year-long `cache-control`.

`_headers` also sets the caching policy: a year on the content-hashed `/_astro/*` assets, and
always-revalidate on `/sw.js`, whose precache manifest would otherwise pin a whole stale build
offline.

## Limitations

Redaction is only as good as what you tell it to remove, and blakstrip would rather say so than
imply more than it does. See [SECURITY.md](./SECURITY.md) for the full threat model.

- **EXIF/GPS inside a PDF's embedded photo is detected, not stripped.** Removing it there would
  mean rewriting the embedded image stream; drawing a box anywhere on that page rasterizes it and
  takes the EXIF with it. (Standalone photos are a different matter: the media tool strips them
  losslessly, without re-encoding.)
- **Optional-content (layer) PDFs are not fully cleaned** on pages copied verbatim, and the export
  loses the layer visibility settings, so a hidden layer may become visible. blakstrip detects this
  and refuses a clean verdict.
- **Encrypted PDFs are refused**; re-save without protection first.
- **Untouched pages keep selectable text.** Only pages you redact are rasterized.
- **Verify only checks what you redacted.** It cannot know what you missed, which is why it lists
  everything still readable in the output.

## Getting started

Requires Node 26+ (see `.nvmrc`) and pnpm (the repo pins a version via `packageManager`).
Node 26 no longer bundles Corepack, so install pnpm yourself: `npm i -g pnpm`, or via a
version manager such as mise.

```sh
pnpm install
pnpm dev        # dev server at http://localhost:4321
```

`pnpm build` produces the static site in `dist/`. The strict CSP and the PWA exist only in a
production build (`pnpm build && pnpm preview`), not in `pnpm dev`.

## Scripts

| Command                                  | What it does                                                          |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `pnpm dev`                               | Astro dev server                                                      |
| `pnpm build` / `pnpm preview`            | production build / preview (CSP + PWA only exist here)                |
| `pnpm test` / `pnpm test:coverage`       | Vitest (browser + node); coverage is gated at 100% on `src/lib/**`    |
| `pnpm test:e2e`                          | Playwright redaction flow + axe accessibility checks                  |
| `pnpm lint` / `pnpm format` / `pnpm fix` | ESLint / Prettier / both                                              |
| `pnpm type-check`                        | `astro check`                                                         |
| `pnpm validate`                          | format:check + lint + type-check + build                              |
| `pnpm verify`                            | test:coverage + build + test:e2e (run by the pre-push hook on `main`) |
| `pnpm gen:icons` / `pnpm gen:fixtures`   | regenerate the logo asset / test PDFs                                 |

## Project layout

```
src/lib/pdf/        framework-free redaction engine (security-critical)
  types.ts          shared contracts (no pdf.js / pdf-lib / DOM types leak out)
  render.ts         pdf.js loading + canvas rendering
  textlayer.ts      text extraction + measured search geometry
  audit.ts          audit-on-load
  inspect.ts        structural leak-vector enumeration (shared by audit + verify)
  redact.ts         build the redacted doc (rasterize + copy)
  metadata.ts       strip passes + mark-sweep garbage collection
  coverage.ts       pixel backstop: source ink vs output black
  export.ts         orchestrate build, strip, save
  download.ts       save bytes to disk (kept clear of pdf-lib so it loads eagerly)
  verify.ts         verify-on-export
src/lib/media/      framework-free image engine (security-critical)
  types.ts          shared contracts (strip results, keep options)
  bytes.ts          bounds-checked readers; refuses malformed input
  jpeg.ts           marker-segment parse, classify, strip
  png.ts            chunk parse, classify, strip (keeps APNG animation)
  webp.ts           RIFF chunk parse, strip, VP8X flag rewrite
  exif.ts           TIFF/IFD parse: turns "GPS present" into coordinates
  compress.ts       presets, resize maths, worker protocol
  compressor.ts     worker lifecycle, supersede, teardown
  compress.worker.ts  decode, resize, encode with the inlined codecs
  index.ts          detect / inspect / strip / verify
src/lib/history.ts  undo/redo over immutable snapshots
src/config/tools.ts single source of truth for the tool list (nav, hub, sitemap,
                    structured data)
src/components/     Redactor.svelte and MediaStripper.svelte (the apps), with
                    AuditPanel, DropZone, PageThumbs, VerifyDialog, FindingsList
                    and CompressPanel split out; InstallButton, Header.astro,
                    Footer.astro
src/pages/          index.astro (hub), pdf-redact.astro, media-strip.astro
tests/              Vitest (node + real-Chromium browser projects) + Playwright e2e + axe
scripts/            gen-icons, gen-fixtures, size-budget
```

## Contributing

- **No network egress.** Nothing in `src/` may fetch, upload, or send the user's file anywhere; the
  strict CSP enforces it. Keep it that way.
- The 100% coverage gate on `src/lib/**` is enforced; new engine code needs matching tests.
- Tooling (ESLint, Prettier, lefthook, commitlint) is configured in this repo, one file each at the
  root. Commits follow Conventional Commits.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, tests, and the full workflow.

## Versioning

This project follows [Semantic Versioning](https://semver.org). See [CHANGELOG.md](./CHANGELOG.md)
for the release history and [RELEASING.md](./RELEASING.md) for how to cut a release.

## Security

Found a way to recover redacted content, or anything that leaks the user's file? Please report it
privately: see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © sixra
