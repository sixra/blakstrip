# blakstrip

A fully in-browser PDF redactor that **removes** content instead of covering it. Nothing is
uploaded — the file is opened, redacted, and saved entirely on your device.

- **Removed, not covered.** Pages you redact are rasterized to a flat image with the black boxes
  burned into the pixels, so the underlying text, vectors, and hidden layers are gone — not sitting
  under a rectangle. Pages you don't touch are copied verbatim and keep selectable text.
- **Finds hidden data.** On load it audits what's lurking in the file (author metadata, XMP,
  annotations, form values, attachments, embedded JavaScript) and strips it on export.
- **Proof, not promises.** After export it re-inspects the output and shows you what, if anything,
  is still recoverable, before you download.
- **Provably private.** A strict Content-Security-Policy (`connect-src 'none'` in production) blocks
  all network egress — verifiable in devtools — and it works fully offline as a PWA.

## How it works

1. **Load** — the file is read into memory and rendered with pdf.js (no network). The original bytes
   are kept for pdf-lib.
2. **Audit** — `inspectStructure` enumerates leak vectors (metadata, XMP, annotations, attachments,
   JavaScript) and a text-layer check flags scans.
3. **Redact** — draw boxes, or search a term and redact every match. Rects are stored in normalized,
   resolution-independent coordinates.
4. **Export** — redacted pages are re-rendered to canvas, the black boxes are painted into the
   pixels, and the flattened PNG replaces the page; untouched pages are `copyPages`-copied. Then
   `stripAll` removes metadata/XMP/annotations/forms/JS/attachments and garbage-collects the
   orphaned objects, and the doc is saved as a single revision.
5. **Verify** — the output is re-opened and re-inspected; the dialog lists any recoverable text or
   surviving structure before you confirm the download.

## Tech

Astro 7 (static, `<meta>` CSP) · Svelte 5 (runes) islands · pdf-lib (write/strip) ·
pdfjs-dist (render/text) · Tailwind v4 · `@vite-pwa/astro`. TypeScript strict.

## Project layout

```
src/lib/pdf/        the framework-free redaction engine (security-critical)
  types.ts          shared contracts (no pdf.js / pdf-lib / DOM types leak out)
  render.ts         pdf.js loading + canvas rendering
  textlayer.ts      text extraction + measured search geometry
  audit.ts          audit-on-load
  inspect.ts        structural leak-vector enumeration (shared by audit + verify)
  redact.ts         build the redacted doc (rasterize + copy)
  metadata.ts       strip passes + mark-sweep garbage collection
  export.ts         orchestrate build -> strip -> save + download
  verify.ts         verify-on-export
src/components/     Redactor.svelte (the app), InstallButton.svelte, Header.astro
src/pages/          index.astro (marketing), pdf-redact.astro (the tool)
tests/              vitest (node + real-Chromium browser projects) + Playwright e2e + axe
scripts/            gen-icons, gen-fixtures
```

## Scripts

| Command                                  | What it does                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`                               | Astro dev server                                                       |
| `pnpm build` / `pnpm preview`            | production build / preview (CSP + PWA only exist here, not in dev)     |
| `pnpm test` / `pnpm test:coverage`       | Vitest (browser + node); coverage is gated at **100%** on `src/lib/**` |
| `pnpm test:e2e`                          | Playwright redaction flow + axe accessibility checks                   |
| `pnpm lint` / `pnpm format` / `pnpm fix` | ESLint / Prettier / both                                               |
| `pnpm type-check`                        | `astro check`                                                          |
| `pnpm validate`                          | format:check + lint + type-check + build                               |
| `pnpm verify`                            | test:coverage + build + test:e2e (run by the pre-push hook on `main`)  |
| `pnpm gen:icons` / `pnpm gen:fixtures`   | regenerate the logo asset / test PDFs                                  |

## Ground rules

- **No network egress.** Nothing in `src/` may fetch, upload, or send the user's file anywhere; the
  strict CSP enforces it. Keep it that way.
- **The 100% coverage gate on `src/lib/**` is real** — new engine code needs matching tests.
- Tooling (ESLint/Prettier/lefthook/commitlint) comes from `@sixra/devkit`; commits follow
  Conventional Commits.
