# blakstrip — Prioritized Code Audit Report

_Findings that survived adversarial verification, de-duplicated across lenses and ranked by severity × confidence. Each item is marked **CONFIRMED** (mechanism verified in code) or **PLAUSIBLE** (real gap, but exact failure mechanism partly contested)._

---

## Executive summary

**Counts by severity (de-duplicated):** 2 critical · 13 high · 15 medium · 17 low = **47 distinct findings**.

**Confidence:** 40 CONFIRMED · 7 PLAUSIBLE.

**The through-line:** blakstrip's core promise is "the black box _destroys_ the content, and verify _proves_ it." Multiple confirmed defects break both halves of that promise at once — the redaction can land in the wrong place (rotation, RTL, font-substitution, stale cross-document state) while `verifyExport` is _structurally incapable_ of noticing, because it only re-extracts text/structure from a page that has already been flattened to a text-less image. Whenever geometry is wrong, verify still reports "clean."

**Top risks (must-fix first):**

1. **Verify is blind to the only leak the model can produce** (`verify.ts:30`, high/CONFIRMED). Redacted pages are rasterized to a text-less PNG; verify only re-extracts text, so a black box that visually under-covers a glyph is certified "clean." This turns every geometry bug below into a _silent_ leak with a green checkmark.
2. **Stale cross-document search state paints redactions at the wrong coordinates and certifies them clean** (`Redactor.svelte:131`/`279`, high/CONFIRMED). `openFile()`/`reset()` never clear `searchMatches`/`searchTerm`/`noMatches`; committing them onto a _different_ document rasterizes a box in the wrong place while verify (term absent from the new file) reports success.
3. **Owner-password / permissions-encrypted PDFs silently break the whole flow** (`redact.ts:45`, high/CONFIRMED). pdf.js opens them; pdf-lib throws `EncryptedPDFError` on load, so the on-load audit panel silently vanishes and export fails — for exactly the file class most likely to carry hidden data.

---

## A) Security / redaction-correctness (must-fix)

- **`src/lib/pdf/verify.ts:30` — high / CONFIRMED — Verify never inspects pixels, only re-extracts text.**
  Why: redacted pages are flattened to a PNG with no text layer, so `extractAllText` returns nothing and every `haystack.includes(term)` trivially passes; `inspectStructure` sees no annotations/text. Verify only proves "text is unselectable" — a property rasterization already guarantees — and gives zero assurance about visible residual ink.
  Failure: a search box under-covers by 3pt leaving `7890` visible in the PNG; verify shows the green "nothing survived" proof before download.
  Fix: after building output, re-render each redacted page to a canvas and assert every rect region (interior + 1–2px border, over the union of covered glyph bboxes) is (near-)fully black below a luminance threshold. At minimum, gate "clean" on that pixel check for search/hand-drawn rects and loudly document the limitation.

- **`src/components/Redactor.svelte:131` (and `:279`) — high / CONFIRMED — Stale search state leaks across documents.**
  Why: `openFile()`/`reset()` clear `rects/past/future/thumbs/auditReport` but never `searchMatches/searchTerm/noMatches`. Stale match rects (previous doc's page numbers, normalized coords, term) survive; the "Redact all N" button stays live (gated only on `searchMatches.length`), and `redactAllMatches()` commits them onto the new document. `buildRedactedPdf` rasterizes the new page with the box at the old coordinates; `verifyExport`'s global substring check finds the old term absent and reports clean.
  Failure: search "SECRET" in file A, don't redact, open file B, click "Redact all 1" → B rasterized with a black box in the wrong spot; verify certifies clean while "SECRET" is still visible in B's image.
  Fix: introduce a single `resetDocState()` helper called by both `openFile()` and `reset()` that also resets `searchMatches=[]; searchTerm=''; noMatches=false; searching=false; verifyResult=null; pendingBytes=null; preview=null; drawing=false;`.

- **`src/lib/pdf/textlayer.ts:150` — high / CONFIRMED — Rotated pages (`/Rotate` 90/180/270) mis-place search boxes.**
  Why: `glyphMetrics`/`glyphBox`/`searchPageRects` use raw text-item transforms (`originX=tr[4]`, `baselineY=tr[5]`, horizontal `item.width`) — which are in unrotated PDF user space — but normalize against the rotation-aware `getViewport({scale:1})` (whose width/height are swapped for 90/270). Axes disagree; `redact.ts` rasterizes with the rotation-aware viewport, so the box lands in the wrong quadrant. (Also covers non-zero `tr[1]/tr[2]` rotated text runs.)
  Failure: a landscape scan stored as portrait with `/Rotate 90` containing an SSN; "Redact all" places the box in empty margin, SSN printed unobscured, verify clean.
  Fix: map each glyph rect through `page.getViewport({scale:1}).transform` (rotation included) / `Util.applyTransform` before normalizing, instead of a manual y-flip; for rotated text matrices compute the rotated quad's axis-aligned bounds. Add a rotated-page fixture (see F).

- **`src/lib/pdf/textlayer.ts:189` — high / CONFIRMED — RTL/bidi runs get the box on the wrong side.**
  Why: pdf.js's `item.str` is bidi-reordered (logical order) while `item.transform`/`item.width` still describe visual glyph layout; measuring `str.slice(0, localStart)` left-to-right and adding to the origin lands the box opposite the actual glyphs. No `dir`/RTL handling exists anywhere in `src/`.
  Failure: Arabic contract, name at the visual right end of a run; box paints the left portion, name stays visible in the raster, verify (no text) shows the green checkmark.
  Fix: detect run directionality (pdf.js `dir`/style, or Unicode ranges); for RTL measure the offset from the right edge (`originX + item.width`), or fall back to covering the whole run bbox — consistent with the code's "cover more, never less" policy.

- **`src/lib/pdf/textlayer.ts:189` — high / CONFIRMED — Font-substitution horizontal under-cover.**
  Why: `styles[fontName].fontFamily` is only a generic bucket (`sans-serif`/`serif`/`monospace`), so `measureText` always runs against a substitute. The `scale = item.width / measureText(str)` rescale fixes the _total_ run width but not per-glyph distribution, so `preW` (advance before the match) can be materially wrong for tabular figures/condensed faces/heavy kerning; the box is then clamped to the run's own measured sub-extent with only a fixed ~0.9pt `SAFETY_X` pad.
  Failure: condensed embedded font; prefix over-measures by ~3pt, shifting `nLeft` right, leaving the leading `12` of the match exposed.
  Fix: don't clamp away the margin against the run's own sub-extent — clamp only against real neighbouring runs (previous run's right edge, next run's left edge on the same line) and fill the gap to those boundaries; when a match spans a whole run, cover the full run box with no measurement; for partial matches widen `SAFETY_X` proportionally to run length / font size.

- **`src/lib/pdf/redact.ts:45` — high / CONFIRMED — Encrypted/permissions-protected PDFs crash the flow and silently drop the audit.**
  Why: neither `redact.ts:45` nor `inspect.ts:27` passes `ignoreEncryption:true`; pdf-lib 1.17 throws `EncryptedPDFError` on any `/Encrypt` doc (default `ignoreEncryption=false`). pdf.js opens owner-password/empty-user-password files fine, so the page renders and the user draws redactions, but `runAudit`'s bare `catch` sets `auditReport=null` (panel just disappears) and export throws.
  Failure: an Acrobat "restrict editing" bank statement renders normally, audit panel never appears (user assumes clean), Export fails with no useful message; hidden metadata unreported.
  Fix: pass `{ ignoreEncryption: true }` to both `PDFDocument.load` calls; surface a distinct "password/owner-protected" state instead of swallowing the audit error.

- **`src/lib/pdf/textlayer.ts:201` — medium / CONFIRMED — Vertical under-cover of deep descenders/ascenders on large fonts.**
  Why: vertical extent is `fontH*0.22 + PAD_Y*ph`, where `PAD_Y=0.0012` is a page-absolute fraction (~0.95pt) that doesn't scale with font size; the file's own `glyphMetrics` treats 0.28·fontH as the real descender depth. For large fonts the 0.06·fontH gap outgrows the fixed ~1pt pad.
  Failure: 40pt heading in a 0.28-em-descender font → box covers 9.75pt below baseline vs 11.2pt needed, leaving ~1.5pt of `g`/`y` tails visible.
  Fix: make margins font-relative — descent factor ≥0.30·fontH, ascent margin above `item.height` (cover `baselineY + 1.15·fontH`), and replace `PAD_Y` with a small multiple of `fontH`.

- **`src/lib/pdf/inspect.ts:54` — medium / CONFIRMED — EXIF/GPS in copied JPEGs → false "clean."**
  Why: `stripEmbeddedMetadata` only deletes the XObject's `/Metadata` (XMP) key and explicitly leaves EXIF baked into DCTDecode bytes; `inspectStructure` enumerates dicts by `/Type` and never parses image bytes; unredacted pages are copied verbatim via `copyPages`. So GPS lat/long and camera serials survive and `verifyExport` reports clean.
  Failure: page 1 has a geotagged JPEG (kept), page 2 is redacted; attacker runs exiftool on the extracted JPEG to recover the photo's exact location.
  Fix: scan DCTDecode XObject bytes for an APP1 `Exif`/GPS marker and emit a finding; to remove, decode+re-encode dropping EXIF (or rasterize pages carrying such images). At minimum, never assert `clean:true` while an un-inspected DCTDecode stream is present.

- **`src/lib/pdf/render.ts:79` — medium / PLAUSIBLE — Raster canvas never clamped to browser max dimensions/area, and the raster is never validated.**
  Why: canvas is sized `ceil(viewport.w) × ceil(viewport.h)` at fixed `RASTER_SCALE=2` with no cap vs WebKit (~16.7M px area / ~4096–8192/side) or Chrome limits, and `page.render()` is awaited with no post-render check. A 4000×3000pt page → 8000×6000 = 48M px. _(Verifier nuance: the most likely WebKit outcome is a fully-failed context → blank/over-redacted page, not the mis-registered box the original claim described; Chrome may yield a null `toBlob`. Either way = data loss or a silently blank "redacted" page reported clean.)_
  Failure: large-format Safari export produces a blank or blank-ish page; verify finds no text and reports clean.
  Fix: compute an effective scale clamping both max side and total area to conservative cross-browser limits (lower `RASTER_SCALE` for oversized pages); after render+fill, sanity-check non-zero dimensions and a non-null/non-trivial `toBlob`, and throw a clear error so export aborts rather than emitting a blank/mis-registered page.

- **`src/lib/pdf/metadata.ts:14` — low / CONFIRMED — `/CreationDate` and `/ModDate` survive into output; verify never checks dates.**
  Why: `PDFDocument.create()`'s constructor stamps both dates via `updateInfoDict()`; `stripDocInfo` blanks only Title/Author/Subject/Keywords/Producer/Creator; `inspectStructure` never reads dates. Leftover timestamp + timezone discloses redaction time and locale.
  Fix: in `stripDocInfo` also `info.delete(PDFName.of('CreationDate'|'ModDate'|'Trapped'))` and clear remaining custom keys; have `inspect` report the dates so audit↔verify stay symmetric.

- **`src/lib/pdf/inspect.ts:54` — low / CONFIRMED — Optional-content (OCG/OCMD) hidden layers become visible and are never detected.**
  Why: a default-off layer on a kept page is copied verbatim, but the catalog `/OCProperties` config is _not_ carried into the fresh output document (pdf-lib has no OCG handling), so many viewers now render the previously-hidden layer; text extraction recovers it regardless. No OCG check in `inspect`.
  Fix: detect catalog `/OCProperties` / marked-content OC references and surface a finding; on export, withhold the clean verdict (or rasterize) when optional content is present on copied pages.

- **`src/lib/pdf/redact.ts:61` — low / PLAUSIBLE — Antialiased fringe at box boundary.**
  Why: rects are painted with fractional device-pixel coords via `ctx.fillRect` (default antialiasing), so the boundary row blends #000 with the underlying original pixel and is preserved losslessly in the PNG; contrast boosting could recover glyph edges flush against the box. _(Verifier nuance: at RASTER_SCALE=2 this is a single sub-pixel row and requires a razor-aligned box; the UI already tells users to over-cover — hence genuinely low.)_
  Fix: snap the fill outward to whole device pixels (`x0=floor(r.x*w)`, `x1=ceil((r.x+r.w)*w)`, etc.) plus 1px margin; set `imageSmoothingEnabled=false`.

- **`src/lib/pdf/verify.ts:34` — low / CONFIRMED — Raw substring leak test yields false positives and can't confirm short terms.**
  Why: `haystack.includes(term.toLowerCase())` has no word boundary and no page-origin correlation. Redacting "Lee" while an unrelated page keeps "flee" → `leakedTerms:['Lee']`, `clean:false` forever; habituates users to dismiss real warnings.
  Fix: match on token/word boundaries against structured extracted items, and only treat a term as leaked if it survives on a page that was _copied_ (not rasterized) — track which pages were rasterized.

---

## B) API currency / standards updates

- **`astro.config.mjs:25` — medium / CONFIRMED — No `frame-ancestors` / `X-Frame-Options`; CSP is `<meta>`-only so it _can't_ be added there.**
  Why: `frame-ancestors`, `sandbox`, `report-uri` are spec-ignored when the policy is delivered via `<meta>`. A privacy tool that processes sensitive docs client-side is fully framable → clickjacking/UI-redress.
  Fix: add hosting-level response headers (`public/_headers` for Netlify/Cloudflare Pages, or host equivalent): `X-Frame-Options: DENY` and header-delivered `Content-Security-Policy: frame-ancestors 'none'`. Header CSP also applies from byte zero.

- **`package.json:49` — medium / PLAUSIBLE — `@sixra/devkit` pinned to `github:sixra/devkit#main` (floating branch), `hasBin:true`.**
  Why: only _incidentally_ pinned by the lockfile's current commit; any non-frozen `pnpm install`/`pnpm update`/lockfile regen re-resolves to whatever HEAD is, with no registry integrity/provenance and a review-invisible hash diff. _(Verifier nuance: devkit has no `postinstall` script and its bin is never invoked, and an ordinary `pnpm install` reuses the pinned resolution unless the specifier changes — so the exposure requires an explicit `pnpm update`/lockfile regen, not merely any install. Still an un-intended, mutable link in an otherwise verifiable supply chain.)_
  Fix: pin to an immutable ref `github:sixra/devkit#<full-sha>` (or a tag) and bump deliberately with a visible diff; or publish to npm with semver.

---

## C) Architecture / modularity / maintainability

> Includes memory/lifecycle, reactivity/race, error-surfacing, boundary, and accessibility findings (no dedicated a11y bucket in the requested structure; the two **critical** items below are the highest-priority in this section).

- **`src/components/Redactor.svelte:479` — critical / CONFIRMED — Per-rect delete "×" button is keyboard-unreachable.**
  Why: it's `hidden ... group-hover:flex` with no `group-focus-within`/`focus` variant, so it's `display:none` (out of tab order) until mouse hover. Undo only rolls back the latest commit, so removing an earlier box is impossible by keyboard.
  Fix: give it stable tab presence — drop `hidden`/hover-gating or add `group-focus-within:flex` + `focus:flex`, plus a visible focus ring.

- **`src/components/Redactor.svelte:461` — critical / CONFIRMED — No keyboard path to author a redaction box; search path is disabled for scans.**
  Why: boxes are created only via pointerdown/move/up on a non-focusable overlay with no role/keydown; when `!hasTextLayer` the search input is disabled, and the audit tells scan users to "draw boxes." A keyboard/switch user cannot redact a scanned PDF at all — the product's highlighted workflow.
  Fix: make the overlay (or a nearby control) focusable with an accessible name; support Enter-to-start / arrow-move+resize / Enter-commit / Escape-cancel, with `aria-describedby` instructions.

- **`src/components/Redactor.svelte:127` — high / CONFIRMED — pdf.js documents/workers are never destroyed (memory leak).**
  Why: `.destroy()` appears nowhere. `openFile` overwrites `doc` and `reset()` nulls it without `doc.destroy()`; worse, every Export runs `verifyExport → recoverableStrings → loadPdf(...)`, spinning a fresh worker to re-parse the (large, rasterized) output and discarding it. Batch/iterative use accumulates worker threads + page caches until the tab OOMs.
  Fix: `await doc.destroy()` in `openFile` (before reassigning) and in `reset()`; wrap verify's throwaway `loadPdf` in try/finally with `.destroy()`; add an `onDestroy`/effect-teardown; optionally share one `PDFWorker` for the short-lived verify/audit loads.

- **`src/components/Redactor.svelte:163` — high / CONFIRMED — Concurrent `page.render()` on the same canvas throws and wedges the overlay.**
  Why: `renderToken` is only rechecked after `getPage()`; the in-flight `page.render()` is never cancelled. pdf.js throws "Cannot use the same canvas during multiple render() operations"; with no try/catch it's an unhandled rejection, `pageRendered` never flips true, and `onPointerDown` (which requires it) silently stops accepting boxes.
  Failure: click "Next" twice quickly on a slow-rasterizing PDF.
  Fix: keep the returned `RenderTask` in a module var and `.cancel()` it (swallowing `RenderingCancelledException`) before starting a new render on that canvas; wrap `renderCurrent` in try/catch.

- **`src/lib/pdf/redact.ts:54` — high / CONFIRMED — Rasterization memory scales linearly with (redacted pages × page size); no cap; single final `save()`.**
  Why: every redacted page rasterizes at fixed 2× and its PNG is retained in the growing `out` doc until one `out.save()`. "Apply page to all" on a 300-page bundle → 300–900MB of PNG bytes plus a comparable serialize spike plus resident `pristine` + pdf.js copy → >1GB → tab crash right before download.
  Fix: clamp the longest output side to a fixed pixel budget (~3000px) instead of flat 2×; null each canvas (`canvas.width=canvas.height=0`) after `embedPng`; call `page.cleanup()` after rasterizing; consider `embedJpg` for photo-heavy scans.

- **`src/components/Redactor.svelte:246` — high / CONFIRMED — Dialog opens without focus management (no move-in, no trap, no restore).**
  Why: `role=dialog`/`aria-modal=true` but nothing focuses into it (disabling the just-clicked Export button blurs focus to `<body>`), no Tab trap, no focus restore on close. Screen-reader users get no modal announcement; keyboard users must Tab through the whole page (incl. every page thumbnail) to reach Cancel/Download.
  Fix: on open, store `document.activeElement` and focus an element inside (heading `tabindex=-1` or Cancel); add a scoped Tab/Shift+Tab trap; restore focus in `closeVerify()`/`confirmDownload()`.

- **`src/components/Redactor.svelte:154` (+ `:145`) — medium / CONFIRMED — `buildThumbs`/`runAudit` fired-and-forgotten with no generation guard.**
  Why: unlike `renderCurrent`'s `renderToken`, `buildThumbs(d)` keeps `thumbs = [...thumbs, ...]` for the old doc after a new file opens (interleaved/duplicate-keyed thumbnails → `each_key_duplicate` crash or clicking a thumbnail navigating the wrong doc), and a slow `runAudit` can clobber `auditReport` with a stale document's findings.
  Fix: add a module-scoped `docGeneration` (mirroring `renderToken`), captured at call start, checked before every `thumbs=`/`auditReport=` mutation; increment it in `openFile`/`reset`.

- **`src/components/Redactor.svelte:260` — medium / CONFIRMED — Export/verify failures fail completely silently.**
  Why: `exportPdf()`'s catch sets `errorMsg`, but `errorMsg` is only rendered in the idle/error dropzone branch (`:329`), never in the `ready` state Export is reachable from. `status` stays `ready`, so the button just flickers back to "Export."
  Fix: render `errorMsg` in the ready branch too (inline banner near the toolbar), or route export failures through a visible error state.

- **`src/lib/pdf/render.ts:23` — medium / CONFIRMED — Redundant full-file `data.slice(0)` at the two hottest memory moments.**
  Why: both call sites already hand `loadPdf` a disposable buffer they never reuse (`openFile`'s `buf` after `pristine=buf.slice(0)`; verify's `bytes.slice().buffer`), so the internal defensive copy doubles a file-sized allocation for nothing at load and post-export verify.
  Fix: drop the internal slice; make copy-ownership the caller's responsibility (document in JSDoc) — callers needing to keep their buffer copy first (already done), others hand it over for free pdf.js transfer.

- **`src/lib/pdf/types.ts:3` — medium / CONFIRMED — Engine boundary leaks vendor types despite the header comment's promise.**
  Why: `audit.ts`, `export.ts`, `redact.ts`, `textlayer.ts` export functions typed with `PDFDocumentProxy`/`PDFPageProxy` (pdfjs-dist) and `PDFDocument` (pdf-lib); `render.ts` exposes `HTMLCanvasElement`; so `Redactor.svelte` must `import type { PDFDocumentProxy }` and hold it as state. A pdfjs-dist major bump then forces type fixes in the UI, and test doubles must satisfy pdf.js's full interface.
  Fix: either scope the comment honestly ("no such types are exported from types.ts"), or introduce an opaque `DocHandle` wrapper / narrow structural types re-exported from `types.ts` so vendor types never escape `src/lib/pdf`.

- **`src/components/Redactor.svelte:532` — medium / CONFIRMED — Verify/download dialog (~76 LOC) is self-contained but inlined in the 608-line island.**
  Why: it reads only `verifyResult` and calls `closeVerify`/`confirmDownload`, sharing no drawing/search/thumbnail state — the single clearest "pays off" extraction.
  Fix: extract `VerifyDialog.svelte` taking `report`, `onConfirm`, `onCancel` (Svelte 5 callback props).

- **`src/components/Redactor.svelte:413` — medium / CONFIRMED — Audit severity conveyed by color of an 8px dot only (WCAG 1.4.1).**
  Why: the dot has no `aria-label`/`title`/sr-only text; adjacent text (`{title}: {detail}`) never states severity; red/amber are shape-identical for color-vision-deficient users.
  Fix: add sr-only severity text (`<span class="sr-only">High severity: </span>`) or an explicit text badge alongside the dot.

- **`src/components/InstallButton.svelte:56` — low / CONFIRMED — iOS popover lacks `aria-controls`, Escape-, and click-outside-to-close.**
  Why: `aria-expanded` present but no `id`/`aria-controls` pairing; only close path is re-clicking the same button, so the absolutely-positioned overlay can be left open with no independent dismissal.
  Fix: give the popover an `id` referenced by `aria-controls`; add Escape and outside-click handlers setting `iosHintOpen=false`.

- **`src/components/Redactor.svelte:471` — low / CONFIRMED — Box-positioning markup duplicated 3×.**
  Why: identical `style:left/top/width/height` from `r.*` fractions in committed rects (471–478), drag preview (489–496), search preview (498–505); any geometry change must be made in three places.
  Fix: factor into a Svelte 5 `{#snippet box(r, extraClass)}` (or tiny `RedactionRectBox.svelte`) reused at all three sites. _(Also enables the session-state consolidation from A#2 — a `createSession()` factory + single `resetSession()` used by `reset()` and `openFile()`.)_

---

## D) Simplification / over-engineering to remove

- **`src/lib/pdf/textlayer.ts:147` — medium / CONFIRMED — `{caseSensitive?}` option is unreachable from product code.** Only `tests/browser/textlayer.test.ts:60` passes it; no UI toggle exists; it doubles branches in the most intricate file. Fix: drop `opts` and always case-fold (or wire a real UI control if it's roadmap).
- **`src/lib/pdf/types.ts:67`/`:66` — low / CONFIRMED — `VerifyReport.removed` is dead and its comment describes an unbuilt feature.** `verify.ts:41` always sets `removed:[]`; no reader anywhere. Fix: delete the field, the `removed:[]` assignment, and the comment; compute a real diff at the call site only if/when the feature is built.
- **`src/lib/pdf/types.ts:34` — low / CONFIRMED — `FindingSeverity`/`FindingCategory` declare variants never produced.** `inspect.ts` only emits `medium`/`high` and six categories (never `low`/`info`/`form`). Fix: narrow to `'high'|'medium'` and the six real categories.
- **`src/lib/pdf/redact.ts:23` — low / CONFIRMED — `groupByPage` duplicated byte-for-byte in `textlayer.ts:226-231`.** Fix: extract one `groupRectsByPage(rects): Map<number, RedactionRect[]>` shared by both.
- **`src/lib/pdf/render.ts:28` — low / CONFIRMED — `getPageSize` exported but only its own test calls it.** Fix: delete it (and its test), or route `redact.ts`'s inline `getViewport({scale:1})` through it to give it one real caller.
- **`src/lib/pdf/textlayer.ts:63` — low / CONFIRMED — `indicesOf`'s `if (!needle) return out` guard is self-admittedly unreachable.** Single caller already returns early for empty term. Fix: remove the guard and its `v8 ignore` comment.
- **`astro.config.mjs:17` — low / CONFIRMED — `prefetch:{prefetchAll:false, defaultStrategy:'viewport'}` is inert.** No anchor carries `data-astro-prefetch`, so `defaultStrategy` is never consulted and nothing prefetches. Fix: set `prefetchAll:true`, or add `data-astro-prefetch="viewport"` to the homepage `/pdf-redact` CTA.

---

## E) Comment & docs cleanup

**Remove / rewrite list:**

- **`README.md:1` — high / CONFIRMED — Still the stock "Astro Starter Kit: Minimal" scaffold** (incl. the "🧑‍🚀 Seasoned astronaut? Delete this file" joke). Zero mention of blakstrip, the redaction/security model, or how to run/test. Fix: replace with real docs — rasterize-to-destroy model, metadata/JS/attachment stripping, verify-before-download, `connect-src 'none'`, engine layout (`src/lib/pdf/*`), and real scripts (`pnpm dev`, `test:coverage`, `test:e2e`, `validate`, `verify`).
- **`AGENTS.md:1` / `CLAUDE.md` — medium / CONFIRMED — Byte-identical, generic Astro-only content.** Missing: 100%-coverage gate on `src/lib` (vitest.config.ts), `pnpm validate`/`verify`/`test:coverage`, and the hard `connect-src 'none'` no-egress constraint. Fix: add a project-specific section naming canonical scripts and the no-network-egress rule.
- **`src/lib/pdf/types.ts:66` — medium / CONFIRMED — `removed` doc comment promises a diff the code never computes.** (Remove alongside D's field deletion.)
- **`astro.config.mjs:27` — low / CONFIRMED — `isDev` `connect-src` ternary + comment are misleading dead code.** Astro's `<meta>` CSP does not render in `astro dev` at all, so the branch never applies and the comment's causal claim is wrong. Fix: drop the ternary or reword to "meta CSP does not render in dev (only build/preview); this branch is future-proofing." Optionally add a preview-backed Playwright check that fails on console CSP-violation logs.
- **`src/components/Redactor.svelte:34` — low / CONFIRMED — `// Non-reactive handles.` is wrong for 5 of 6 declarations** (`pageCanvas/overlayEl/viewerEl/fileInput/pageRendered` are `$state`). Fix: reword, e.g. "doc/pristine/renderToken are plain; the rest are `$state` for template bindings."
- **`tests/e2e/redact.spec.ts:12` — low / PLAUSIBLE — Stale changelog comment** ("now that it waits for the page to render"). _(Verifier nuance: the wait it references actually lives in `uploadTextFixture()`, not `drawBox()`; either way it reads as a regression note, not current-behavior docs.)_ Fix: delete or replace with "// Draw a redaction box."

---

## F) Test gaps

- **`src/components/Redactor.svelte:1` — high / CONFIRMED — The 608-line UI orchestration layer has zero unit/component tests.** vitest's 100% gate is scoped to `src/lib/**` only; the sole e2e flow just draws one box and exports. Undo/redo (`future.slice(1)`), `applyToAllPages`, `redactAllMatches`, per-rect delete, drag geometry, file drop, verify gate — all untested, and this is the code that decides which rects reach the export pipeline. Fix: add Playwright/vitest-browser coverage with ≥1 assertion per state-mutating function.
- **`src/lib/pdf/redact.ts:70` — high / CONFIRMED — No `/Rotate` fixture anywhere** exercises the rotation-composition logic that directly underpins the A-bucket rotation leak. Fix: add a rotated fixture (`rotate:90`, or set `/Rotate` post-hoc via pdf-lib); assert output page has swapped width/height and `searchPageRects` returns rects over the correct on-screen region.
- **`tests/browser/textlayer.test.ts:70` — medium / CONFIRMED — Search-geometry precision tests assert only relative/bounds comparisons, no ground truth.** A uniform offset (or an `nLeft`/`nRight` clamp swap, even a negative width) cancels out of every assertion and passes. Fix: render the fixture to a canvas and check the rect's pixel bounds against the actual ink bbox of the target glyphs (sample color at rect edges vs just outside).
- **`src/lib/pdf/render.ts:22` — medium / CONFIRMED — No encrypted/password/corrupt/truncated/huge-PDF test;** the `openFile` catch path is never triggered. Fix: (1) e2e uploading a non-PDF/truncated file asserting the visible error, (2) unit test of `loadPdf` on an encrypted fixture asserting a clear message, (3) optional large multi-hundred-page fixture to bound render/export time.
- **`tests/browser/pipeline.test.ts:74` — low / CONFIRMED — `downloadBytes` is verified only by `.not.toThrow()`.** Wrong MIME, wrong filename, missing `click()`, or leaked object URL all pass. Fix: spy on `createElement`/`click`/`createObjectURL`/`revokeObjectURL` (or assert `a.download`/`a.href`/blob type) before click.

---

## G) Considered but NOT a problem / leave as-is

- **`render.ts:79` mis-registered-box mechanism (as originally framed) — not confirmed.** Documented WebKit behavior for an over-limit canvas is a fully-failed context (all draws no-op) → blank/over-redacted page, not a "top-left render with box against clamped width." The _guard is still worth adding_ (kept in A as data-loss/blank-page risk), but the specific "box exposes the callout" scenario is not the real failure mode.
- **`redact.ts:61` antialiasing fringe — real but immaterial in practice (kept as low).** Single sub-pixel row at 2×; requires a razor-aligned box; UI already instructs over-cover. Snapping is cheap insurance, not a must-fix.
- **`Redactor.svelte:222` off-by-threshold (0.005 min box) — leave as-is.** 0.005 is only ~0.5% of page height (<~4pt); real single-line boxes are several times taller, so the guard filters only accidental jitter clicks, not intentional thin redactions. (Could switch to an OR/area guard as a nicety, not a bug.)
- **`Redactor.svelte:154` O(n²) `thumbs = [...thumbs, ...]` framing — not material.** Array copies are cheap reference copies dwarfed by per-page render/encode; the keyed `{#each}` appends only the new node. The _real_ concern (unbatched, unyielded per-page work contending with the audit scan) is captured under C's race findings; the O(n²)/re-render cost argument itself is a non-issue.
- **`package.json:49` postinstall-execution vector — overstated.** `@sixra/devkit` has no `scripts` field and its bin is never invoked; `hasBin:true` alone doesn't auto-run on install. The mutable-pin concern stands (B), but "malicious postinstall runs on every `pnpm install`" does not.

---

_Legend: severity is the auditor's rating; confidence is CONFIRMED (mechanism verified against code) vs PLAUSIBLE (real gap, contested mechanism or reachability). "Merged" findings collapse duplicate reports of the same root cause across lenses._
