# blakstrip

[![CI](https://github.com/sixra/blakstrip/actions/workflows/ci.yml/badge.svg)](https://github.com/sixra/blakstrip/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A fully in-browser PDF redactor that removes content instead of covering it. The file is opened,
redacted, and saved entirely on your device; nothing is uploaded.

## How it works

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
page, and a matching response-header policy covers the pdf.js worker that actually parses your file.
The only requests the app ever makes are same-origin loads of its own assets; your document is never
among them, which you can confirm in devtools. It works offline as a PWA.

**Stack:** Astro 7 (static, `<meta>` CSP), Svelte 5 (runes) islands, pdf-lib (write/strip),
pdfjs-dist (render/text), Tailwind v4, `@vite-pwa/astro`, TypeScript strict.

## Deploying

`pnpm build` emits a static site to `dist/`, so any static host will serve it. One
requirement is not optional: **the host must apply `public/_headers`** (Cloudflare Pages and
Netlify both read it natively). That file carries the things a `<meta>` CSP cannot express and
that this app's promises depend on:

- `frame-ancestors` / `X-Frame-Options`, the clickjacking defence, which is ignored in a `<meta>`
  policy;
- `Strict-Transport-Security`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-*`;
- the per-path CSP over `/_astro/*` and `/sw.js`, which is what actually constrains the pdf.js
  worker where your document is parsed.

Deploy somewhere that ignores `_headers` and the app still works, but silently without any of
the above. If you fork and host it elsewhere, port those headers to your host's own mechanism.

## Limitations

Redaction is only as good as what you tell it to remove, and blakstrip would rather say so than
imply more than it does. See [SECURITY.md](./SECURITY.md) for the full threat model.

- **EXIF/GPS inside a photo is detected, not stripped.** Removing it means re-encoding the image;
  drawing a box anywhere on that page rasterizes it and takes the EXIF with it.
- **Optional-content (layer) PDFs are not fully cleaned** on pages copied verbatim, and the export
  loses the layer visibility settings, so a hidden layer may become visible. blakstrip detects this
  and refuses a clean verdict.
- **Encrypted PDFs are refused**; re-save without protection first.
- **Untouched pages keep selectable text.** Only pages you redact are rasterized.
- **Verify only checks what you redacted.** It cannot know what you missed, which is why it lists
  everything still readable in the output.

## Getting started

Requires Node 24+ (see `.nvmrc`) and pnpm (the repo pins a version via `packageManager`; Corepack picks it up
automatically).

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
  export.ts         orchestrate build, strip, save, download
  verify.ts         verify-on-export
src/components/     Redactor.svelte (the app), InstallButton.svelte, Header.astro
src/pages/          index.astro (landing), pdf-redact.astro (the tool)
tests/              Vitest (node + real-Chromium browser projects) + Playwright e2e + axe
scripts/            gen-icons, gen-fixtures
```

## Contributing

- **No network egress.** Nothing in `src/` may fetch, upload, or send the user's file anywhere; the
  strict CSP enforces it. Keep it that way.
- The 100% coverage gate on `src/lib/**` is enforced; new engine code needs matching tests.
- Tooling (ESLint, Prettier, lefthook, commitlint) comes from `@sixra/devkit`. Commits follow
  Conventional Commits.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, tests, and the full workflow.

## Versioning

This project follows [Semantic Versioning](https://semver.org). See [CHANGELOG.md](./CHANGELOG.md)
for the release history and [RELEASING.md](./RELEASING.md) for how to cut a release.

## Security

Found a way to recover redacted content, or anything that leaks the user's file? Please report it
privately: see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © sixra
