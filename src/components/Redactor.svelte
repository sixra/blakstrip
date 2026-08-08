<script lang="ts">
  import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
  import { onDestroy, type Snippet } from 'svelte';
  import { canRedo, canUndo, commit as commitHistory, initHistory, redo, undo } from '@lib/history';
  import { downloadPdf, redactedFileName } from '@lib/pdf/download';
  import { loadPdf, renderPageToCanvas, renderPageToImageCanvas } from '@lib/pdf/render';
  import { collectRedactedText, searchDocumentRects } from '@lib/pdf/textlayer';
  import type { AuditReport, RedactionRect, VerifyReport } from '@lib/pdf/types';
  import AuditPanel from './AuditPanel.svelte';
  import DropZone from './DropZone.svelte';
  import PageThumbs from './PageThumbs.svelte';
  import VerifyDialog from './VerifyDialog.svelte';

  type Status = 'idle' | 'loading' | 'ready' | 'error';

  let status = $state<Status>('idle');
  let errorMsg = $state('');
  let fileName = $state('');
  let pageCount = $state(0);
  let currentPage = $state(1);
  let thumbs = $state<{ page: number; url: string }[]>([]);
  let auditReport = $state<AuditReport | null>(null);
  let auditFailed = $state(false);

  // Redaction rectangles (normalized), with undo/redo handled by the history
  // module so its invalidation rules are covered by the engine's test gate.
  let history = $state(initHistory<RedactionRect[]>([]));
  const rects = $derived(history.present);
  /** The rect set most recently written to disk, so we don't warn about saved work. */
  let downloadedRects = $state<RedactionRect[] | null>(null);

  // Plain handles: doc/pristine/renderToken are not reactive; the element refs and
  // pageRendered below use $state so the template can bind to them.
  let doc: PDFDocumentProxy | null = null;
  let pristine: ArrayBuffer | null = null;
  let pageCanvas = $state<HTMLCanvasElement>();
  let overlayEl = $state<HTMLDivElement>();
  let viewerEl = $state<HTMLDivElement>();
  let renderToken = 0;
  let renderTask: RenderTask | null = null;
  // Bumped every time the document changes, so slow fire-and-forget work
  // (thumbnails, audit) started for an old file can detect it's stale and stop.
  let docGeneration = 0;
  let pageRendered = $state(false);

  const pageRects = $derived(rects.filter((r) => r.page === currentPage));

  // Search-redact state.
  let searchTerm = $state('');
  let searchMatches = $state<RedactionRect[]>([]);
  let searching = $state(false);
  let noMatches = $state(false);
  const searchPreview = $derived(searchMatches.filter((r) => r.page === currentPage));
  // Search reads the pdf.js text layer; a scan has none, so it can never match.
  const hasTextLayer = $derived(auditReport?.hasTextLayer ?? true);

  async function runSearch() {
    noMatches = false;
    const term = searchTerm.trim();
    if (!doc || term.length === 0) {
      searchMatches = [];
      return;
    }
    searching = true;
    try {
      const found = await searchDocumentRects(doc, term);
      searchMatches = found;
      noMatches = found.length === 0;
    } finally {
      searching = false;
    }
  }
  function clearSearch() {
    searchMatches = [];
    noMatches = false;
  }
  function redactAllMatches() {
    if (searchMatches.length === 0) return;
    // Each match rect already carries its exact term (see searchPageRects), so
    // verify picks it up from the rects, no separate bookkeeping to drift.
    commit([...rects, ...searchMatches]);
    searchMatches = [];
    searchTerm = '';
  }
  function applyToAllPages() {
    if (pageRects.length === 0) return;
    const additions: RedactionRect[] = [];
    for (let p = 1; p <= pageCount; p += 1) {
      if (p === currentPage) continue;
      for (const r of pageRects) additions.push({ ...r, page: p });
    }
    if (additions.length > 0) commit([...rects, ...additions]);
  }

  // Live preview while dragging a new box (fractions of the overlay).
  let drawing = $state(false);
  let preview = $state<RedactionRect | null>(null);
  let startPt = { x: 0, y: 0 };
  let kbAuthoring = $state(false);
  const KB_STEP = 0.02;

  function commit(next: RedactionRect[]) {
    history = commitHistory(history, next);
  }
  function deleteRect(target: RedactionRect) {
    commit(rects.filter((r) => r !== target));
  }

  // Clear every piece of per-document state. Called before loading a new file and on
  // reset, so stale search matches / rects / verify state from a previous document can
  // never be committed onto (or verified against) the next one.
  function clearTransientState() {
    docGeneration += 1;
    history = initHistory<RedactionRect[]>([]);
    thumbs = [];
    auditReport = null;
    auditFailed = false;
    searchMatches = [];
    searchTerm = '';
    noMatches = false;
    searching = false;
    drawing = false;
    kbAuthoring = false;
    preview = null;
    verifyResult = null;
    pendingBytes = null;
    downloadedRects = null;
    errorMsg = '';
  }

  async function openFile(file: File) {
    status = 'loading';
    const previous = doc;
    doc = null;
    if (previous) void previous.loadingTask.destroy().catch(() => {}); // free the old pdf.js worker
    clearTransientState();
    try {
      const buf = await file.arrayBuffer();
      // loadPdf owns the copy it hands to the worker, so this buffer stays ours.
      pristine = buf;
      doc = await loadPdf(buf);
      pageCount = doc.numPages;
      fileName = file.name;
      currentPage = 1;
      status = 'ready';
      void buildThumbs(doc);
      void runAudit();
    } catch (e) {
      status = 'error';
      errorMsg = e instanceof Error ? e.message : String(e);
    }
  }

  async function runAudit() {
    if (!doc || !pristine) return;
    const gen = docGeneration;
    try {
      const { auditDocument } = await import('@lib/pdf/audit');
      const report = await auditDocument(pristine, doc);
      if (gen === docGeneration) auditReport = report; // ignore a stale document's result
    } catch {
      // An audit that fell over must not look like an audit that found nothing:
      // no panel at all reads as "this file is fine", which is the opposite of
      // what a crash on a malformed file means.
      if (gen === docGeneration) auditFailed = true;
    }
  }

  async function buildThumbs(d: PDFDocumentProxy) {
    const gen = docGeneration;
    try {
      for (let n = 1; n <= d.numPages; n += 1) {
        const page = await d.getPage(n);
        if (gen !== docGeneration) return; // a newer file superseded this run
        const base = page.getViewport({ scale: 1 });
        const canvas = await renderPageToImageCanvas(page, 130 / base.width);
        if (gen !== docGeneration) return;
        thumbs = [...thumbs, { page: n, url: canvas.toDataURL('image/png') }];
      }
    } catch {
      // The doc was destroyed mid-thumbnail (a new file opened); stop quietly.
    }
  }

  async function renderCurrent() {
    if (!doc || !pageCanvas || !viewerEl) return;
    const token = (renderToken += 1);
    pageRendered = false;
    // Cancel a render still in flight on this canvas: pdf.js throws if a second
    // render starts on the same canvas, which would leave pageRendered false and
    // wedge the overlay (e.g. clicking Next twice on a slow page).
    renderTask?.cancel();
    renderTask = null;
    try {
      const page = await doc.getPage(currentPage);
      if (token !== renderToken) return; // a newer render superseded this one
      const target = Math.min(viewerEl.clientWidth, 900);
      const task = renderPageToCanvas(page, pageCanvas, target);
      renderTask = task;
      await task.promise;
      if (token === renderToken) pageRendered = true;
    } catch {
      // A superseded or cancelled render (page/file changed, or the doc was
      // destroyed mid-render); ignore, the latest render wins.
    }
  }

  // Redactions live only in this tab; nothing is stored anywhere. Losing them to a
  // stray navigation means redoing the work on a document the user cared enough
  // about to redact. Not after a download of exactly this set, though: warning
  // about work the user just saved is how people learn to dismiss the prompt.
  // Identity comparison is enough because every commit makes a new array.
  const hasUnsavedWork = $derived(rects.length > 0 && rects !== downloadedRects);
  $effect(() => {
    if (!hasUnsavedWork) return;
    const warn = (e: BeforeUnloadEvent): void => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  });

  // Re-render whenever the document or page changes (runs after DOM is ready).
  $effect(() => {
    void currentPage;
    if (status === 'ready') void renderCurrent();
  });

  // The canvas is sized once from the viewer's width and then carries explicit
  // pixel width *and* height. Narrow the window and `max-w-full` shrinks the width
  // while that inline height stays put, so the page renders squashed and the black
  // boxes visibly stop sitting over the content they cover. Re-fit on resize.
  $effect(() => {
    if (status !== 'ready' || !viewerEl) return;
    const el = viewerEl;
    let last = el.clientWidth;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === last) return; // height-only changes need no re-render
      last = el.clientWidth;
      clearTimeout(timer);
      timer = setTimeout(() => void renderCurrent(), 100);
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  });

  // Tear down the last-open document's worker (and any in-flight render) when the
  // island unmounts, so navigating away doesn't leak a pdf.js worker thread.
  onDestroy(() => {
    renderTask?.cancel();
    if (doc) void doc.loadingTask.destroy().catch(() => {});
  });

  // --- drawing rectangles on the overlay ---
  function fractionsFromEvent(e: PointerEvent) {
    const r = overlayEl!.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
    };
  }
  function onPointerDown(e: PointerEvent) {
    if (!overlayEl || !pageRendered) return; // ignore drags before the page is drawn
    kbAuthoring = false; // a mouse drag cancels any in-progress keyboard box
    startPt = fractionsFromEvent(e);
    drawing = true;
    preview = { page: currentPage, x: startPt.x, y: startPt.y, w: 0, h: 0 };
    overlayEl.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (!drawing || !overlayEl) return;
    const p = fractionsFromEvent(e);
    preview = {
      page: currentPage,
      x: Math.min(startPt.x, p.x),
      y: Math.min(startPt.y, p.y),
      w: Math.abs(p.x - startPt.x),
      h: Math.abs(p.y - startPt.y),
    };
  }
  function onPointerUp() {
    if (!drawing) return;
    drawing = false;
    if (preview && preview.w > 0.005 && preview.h > 0.005) {
      commit([...rects, preview]);
    }
    preview = null;
  }

  // Keyboard authoring: focus the overlay, Enter starts a box, arrow keys move
  // it, Shift+arrow keys resize it, Enter places it, Escape cancels. Lets
  // keyboard and switch users redact scans, where the search path is disabled.
  function onOverlayKey(e: KeyboardEvent) {
    if (!pageRendered) return;
    if (!kbAuthoring) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        drawing = false;
        kbAuthoring = true;
        preview = { page: currentPage, x: 0.4, y: 0.45, w: 0.2, h: 0.1 };
      }
      return;
    }
    if (!preview) return;
    const p = preview;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        kbAuthoring = false;
        preview = null;
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (p.w > 0.005 && p.h > 0.005) commit([...rects, p]);
        kbAuthoring = false;
        preview = null;
        break;
      case 'ArrowLeft':
        e.preventDefault();
        preview = e.shiftKey
          ? { ...p, w: Math.max(0.01, p.w - KB_STEP) }
          : { ...p, x: Math.max(0, p.x - KB_STEP) };
        break;
      case 'ArrowRight':
        e.preventDefault();
        preview = e.shiftKey
          ? { ...p, w: Math.min(1 - p.x, p.w + KB_STEP) }
          : { ...p, x: Math.min(1 - p.w, p.x + KB_STEP) };
        break;
      case 'ArrowUp':
        e.preventDefault();
        preview = e.shiftKey
          ? { ...p, h: Math.max(0.01, p.h - KB_STEP) }
          : { ...p, y: Math.max(0, p.y - KB_STEP) };
        break;
      case 'ArrowDown':
        e.preventDefault();
        preview = e.shiftKey
          ? { ...p, h: Math.min(1 - p.y, p.h + KB_STEP) }
          : { ...p, y: Math.min(1 - p.h, p.y + KB_STEP) };
        break;
    }
  }

  function goTo(n: number) {
    currentPage = Math.min(Math.max(1, n), pageCount);
  }

  let exporting = $state(false);
  let verifyResult = $state<VerifyReport | null>(null);
  let pendingBytes: Uint8Array | null = null;
  let returnFocusTo: HTMLElement | null = null;
  let exportStep = $state('');

  // Zero rects is a legitimate export: every page is copied and stripAll still
  // runs, which is exactly what a user whose problem is the audit panel wants.
  async function exportPdf() {
    if (!doc || !pristine || exporting) return;
    // Captured before the button disables itself: a focused element that becomes
    // disabled hands focus to <body>, so by the time the dialog opens there is
    // nothing sensible left for it to restore to on close.
    returnFocusTo = document.activeElement as HTMLElement | null;
    exporting = true;
    errorMsg = '';
    try {
      // pdf-lib is only needed once there is a document to work on, so it is
      // loaded here rather than shipped in the island's first chunk.
      const [{ exportRedactedPdf }, { verifyExport }] = await Promise.all([
        import('@lib/pdf/export'),
        import('@lib/pdf/verify'),
      ]);
      const bytes = await exportRedactedPdf(pristine, doc, rects, (done, total) => {
        exportStep = `page ${done} of ${total}`;
      });
      exportStep = 'verifying';
      pendingBytes = bytes;
      // Re-check that the text we actually covered is gone from the output, not
      // just that no structural leak vectors remain. Exact search terms travel
      // on the rects; hand-drawn boxes contribute the whole runs they cover.
      // Search terms are checked document-wide: search redacted every match, so a
      // survivor anywhere is a genuine failure. Text under a hand-drawn box is
      // page-local, so it is passed separately and reported as "also on page N".
      const rectTerms = [
        ...new Set(rects.map((r) => r.term).filter((t): t is string => Boolean(t))),
      ];
      const boxText = await collectRedactedText(doc, rects);
      // Pass the source doc + rects so verify also re-reads the output pixels and
      // proves each redaction actually landed black over its target.
      verifyResult = await verifyExport(bytes, rectTerms, { doc, rects }, boxText);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      exporting = false;
      exportStep = '';
    }
  }

  function confirmDownload() {
    if (pendingBytes) {
      downloadPdf(pendingBytes, redactedFileName(fileName));
      downloadedRects = rects;
    }
    closeVerify();
  }
  function closeVerify() {
    verifyResult = null;
    pendingBytes = null;
    returnFocusTo?.focus();
  }

  function reset() {
    const previous = doc;
    doc = null;
    if (previous) void previous.loadingTask.destroy().catch(() => {});
    pristine = null;
    clearTransientState();
    status = 'idle';
    fileName = '';
    pageCount = 0;
    currentPage = 1;
  }

  const btn =
    'rounded-lg border border-line px-3 py-1.5 text-sm text-ink transition hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-40';

  // Everything here happens asynchronously and is otherwise announced only by a
  // button label changing, which screen readers report unreliably. The region is
  // always mounted (one injected alongside its text is routinely missed) and the
  // ordering is most-urgent-first, so a single live area covers the whole flow.
  const liveStatus = $derived(
    status === 'loading'
      ? 'Opening file.'
      : exporting
        ? `Exporting redacted PDF, ${exportStep}.`
        : searching
          ? 'Searching.'
          : noMatches
            ? 'No matches found.'
            : searchMatches.length > 0
              ? `${searchMatches.length} matches found.`
              : kbAuthoring && preview
                ? `Redaction box at ${Math.round(preview.x * 100)} percent from left, ${Math.round(preview.y * 100)} percent from top, ${Math.round(preview.w * 100)} by ${Math.round(preview.h * 100)} percent.`
                : auditReport
                  ? `Document ready, ${pageCount} pages, ${auditReport.findings.length} hidden items found.`
                  : ''
  );
</script>

<div class="mx-auto w-full max-w-6xl">
  <p class="sr-only" role="status" aria-live="polite">{liveStatus}</p>
  {#if status === 'idle' || status === 'error'}
    <DropZone
      error={status === 'error' ? errorMsg : ''}
      prompt="Drop a PDF to redact"
      accept="application/pdf"
      inputLabel="Choose a PDF file"
      validate={(file) =>
        // Some platforms hand over a PDF with an empty type, so fall back to the
        // extension. Anything else gets a visible reason rather than silence.
        file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
          ? undefined
          : `${file.name} is not a PDF.`}
      onFile={(file) => void openFile(file)}
      onReject={(reason) => {
        status = 'error';
        errorMsg = reason;
      }}
    />
  {:else}
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <span class="text-muted max-w-56 truncate text-sm">{fileName}</span>
      <span class="text-muted text-xs">{rects.length} redaction{rects.length === 1 ? '' : 's'}</span
      >
      <div class="ml-auto flex items-center gap-2">
        <button class={btn} onclick={() => (history = undo(history))} disabled={!canUndo(history)}
          >Undo</button
        >
        <button class={btn} onclick={() => (history = redo(history))} disabled={!canRedo(history)}
          >Redo</button
        >
        <button
          class="bg-redact text-surface rounded-lg px-3 py-1.5 text-sm font-semibold transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          onclick={exportPdf}
          disabled={exporting}
          >{exporting
            ? `Exporting… ${exportStep}`
            : rects.length === 0
              ? 'Strip metadata'
              : 'Export'}</button
        >
        <button class={btn} onclick={reset}>New file</button>
      </div>
    </div>

    {#if errorMsg}
      <p
        class="border-danger/40 bg-danger-surface text-danger mb-4 rounded-lg border px-3 py-2 text-sm"
        role="alert"
      >
        {errorMsg}
      </p>
    {/if}

    <div class="mb-4 flex flex-wrap items-center gap-2">
      <input
        bind:value={searchTerm}
        oninput={clearSearch}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void runSearch();
          }
        }}
        type="search"
        disabled={!hasTextLayer}
        placeholder="Find text to redact across all pages…"
        aria-label="Find text to redact"
        aria-describedby={hasTextLayer ? undefined : 'no-text-layer-help'}
        class="border-line-strong bg-raised text-ink placeholder:text-faint focus:border-redact disabled:bg-line disabled:text-faint w-full max-w-72 rounded-lg border px-3 py-1.5 text-sm focus:outline-none disabled:cursor-not-allowed"
      />
      <button
        class={btn}
        onclick={runSearch}
        disabled={searching || searchTerm.trim().length === 0 || !hasTextLayer}
      >
        {searching ? 'Searching…' : 'Find'}
      </button>
      {#if searchMatches.length > 0}
        <button
          class="bg-warning-solid text-ink rounded-lg px-3 py-1.5 text-sm font-semibold transition hover:opacity-90"
          onclick={redactAllMatches}>Redact all {searchMatches.length}</button
        >
      {:else if noMatches}
        <span class="text-muted text-xs">No matches</span>
      {/if}
      <button
        class={`${btn} ml-auto`}
        onclick={applyToAllPages}
        disabled={pageRects.length === 0}
        title="Copy this page's redaction boxes onto every page (repeating headers/footers)"
        >Apply page to all</button
      >
      {#if auditReport && !hasTextLayer}
        <p id="no-text-layer-help" class="text-warning basis-full text-xs">
          This file has no text layer, so search can't find words. Draw boxes to redact instead.
        </p>
      {/if}
    </div>

    {#if auditReport}
      <AuditPanel report={auditReport} />
    {:else if auditFailed}
      <p
        class="border-warning bg-warning-surface text-warning mb-4 rounded-xl border p-4 text-sm"
        role="alert"
      >
        Couldn't inspect this file for hidden data, so nothing is listed above. That is not a clean
        bill of health: treat it as unknown, and read the verify dialog carefully before you
        download.
      </p>
    {/if}

    <div class="grid grid-cols-1 gap-4 sm:grid-cols-[130px_1fr]">
      <PageThumbs {thumbs} {currentPage} onSelect={goTo} />

      <div bind:this={viewerEl}>
        <div class="relative inline-block">
          <canvas bind:this={pageCanvas} class="ring-line block max-w-full rounded shadow-md ring-1"
          ></canvas>
          <!-- Intentional: role="application" drawing surface with a documented keyboard model (see #redact-kb-help). -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div
            bind:this={overlayEl}
            class="focus-visible:ring-redact absolute inset-0 cursor-crosshair touch-none focus-visible:ring-2 focus-visible:outline-none"
            data-page-ready={pageRendered}
            data-testid="redact-overlay"
            role="application"
            tabindex="0"
            aria-label="Redaction area"
            aria-describedby="redact-kb-help"
            onpointerdown={onPointerDown}
            onpointermove={onPointerMove}
            onpointerup={onPointerUp}
            onkeydown={onOverlayKey}
          ></div>
          <p id="redact-kb-help" class="sr-only">
            Press Enter to start a redaction box, arrow keys to move it, Shift plus arrow keys to
            resize it, Enter to place it, and Escape to cancel.
          </p>
          <!-- One positioned box, reused for committed rects, the drag preview, and
               search-match previews; the only difference is the class and, for a
               committed rect, the delete button rendered inside. -->
          {#snippet posBox(r: RedactionRect, cls: string, inner?: Snippet<[RedactionRect]>)}
            <div
              class={cls}
              style:left={`${r.x * 100}%`}
              style:top={`${r.y * 100}%`}
              style:width={`${r.w * 100}%`}
              style:height={`${r.h * 100}%`}
            >
              {#if inner}{@render inner(r)}{/if}
            </div>
          {/snippet}
          {#snippet deleteButton(r: RedactionRect)}
            <button
              class="bg-redact text-surface ring-redact pointer-events-auto absolute -top-3 -right-3 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
              onclick={(e) => {
                e.stopPropagation();
                deleteRect(r);
              }}
              aria-label="Remove redaction">×</button
            >
          {/snippet}
          <div class="pointer-events-none absolute inset-0">
            {#each pageRects as r (r)}
              {@render posBox(r, 'group absolute bg-redact', deleteButton)}
            {/each}
            {#if preview}
              {@render posBox(preview, 'absolute border-2 border-redact bg-redact/30')}
            {/if}
            {#each searchPreview as r, i (`s${i}`)}
              {@render posBox(r, 'absolute border-2 border-warning bg-warning-solid/25')}
            {/each}
          </div>
        </div>

        <div class="text-muted mt-3 flex items-center justify-center gap-3 text-sm">
          <button class={btn} onclick={() => goTo(currentPage - 1)} disabled={currentPage <= 1}
            >Prev</button
          >
          <span>Page {currentPage} / {pageCount}</span>
          <button
            class={btn}
            onclick={() => goTo(currentPage + 1)}
            disabled={currentPage >= pageCount}>Next</button
          >
        </div>
      </div>
    </div>
  {/if}

  {#if status === 'loading'}
    <p class="text-muted mt-4 text-center text-sm">Opening…</p>
  {/if}
</div>

<!-- Always mounted, contents gated: unmounting an open dialog would tear it out of
     the top layer without a close event, losing focus restoration. -->
<VerifyDialog report={verifyResult} onCancel={closeVerify} onDownload={confirmDownload} />
