<script lang="ts">
  import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
  import { onDestroy, type Snippet } from 'svelte';
  import { auditDocument } from '@lib/pdf/audit';
  import { downloadBytes, exportRedactedPdf, redactedFileName } from '@lib/pdf/export';
  import { loadPdf, renderPageToCanvas, renderPageToImageCanvas } from '@lib/pdf/render';
  import { collectRedactedText, searchDocumentRects } from '@lib/pdf/textlayer';
  import type { AuditReport, FindingSeverity, RedactionRect, VerifyReport } from '@lib/pdf/types';
  import { verifyExport } from '@lib/pdf/verify';

  type Status = 'idle' | 'loading' | 'ready' | 'error';

  let status = $state<Status>('idle');
  let errorMsg = $state('');
  let fileName = $state('');
  let pageCount = $state(0);
  let currentPage = $state(1);
  let thumbs = $state<{ page: number; url: string }[]>([]);
  let dragOver = $state(false);
  let auditReport = $state<AuditReport | null>(null);

  // FindingSeverity is 'high' | 'medium', so there is no third case to style.
  const sevClass = (s: FindingSeverity): string => (s === 'high' ? 'bg-red-500' : 'bg-amber-500');
  const auditPanelClass = $derived(
    auditReport && auditReport.findings.length > 0
      ? 'border-amber-300 bg-amber-50'
      : 'border-neutral-200 bg-white'
  );

  // Redaction rectangles (normalized) + undo/redo stacks.
  let rects = $state<RedactionRect[]>([]);
  let past = $state<RedactionRect[][]>([]);
  let future = $state<RedactionRect[][]>([]);

  // Plain handles: doc/pristine/renderToken are not reactive; the element refs and
  // pageRendered below use $state so the template can bind to them.
  let doc: PDFDocumentProxy | null = null;
  let pristine: ArrayBuffer | null = null;
  let pageCanvas = $state<HTMLCanvasElement>();
  let overlayEl = $state<HTMLDivElement>();
  let viewerEl = $state<HTMLDivElement>();
  let fileInput = $state<HTMLInputElement>();
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
    past = [...past, rects];
    future = [];
    rects = next;
  }
  function undo() {
    const prev = past.at(-1);
    if (prev === undefined) return;
    future = [rects, ...future];
    rects = prev;
    past = past.slice(0, -1);
  }
  function redo() {
    const nxt = future.at(0);
    if (nxt === undefined) return;
    past = [...past, rects];
    rects = nxt;
    future = future.slice(1);
  }
  function deleteRect(target: RedactionRect) {
    commit(rects.filter((r) => r !== target));
  }

  // Clear every piece of per-document state. Called before loading a new file and on
  // reset, so stale search matches / rects / verify state from a previous document can
  // never be committed onto (or verified against) the next one.
  function clearTransientState() {
    docGeneration += 1;
    rects = [];
    past = [];
    future = [];
    thumbs = [];
    auditReport = null;
    searchMatches = [];
    searchTerm = '';
    noMatches = false;
    searching = false;
    drawing = false;
    kbAuthoring = false;
    preview = null;
    verifyResult = null;
    pendingBytes = null;
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
      const report = await auditDocument(pristine, doc);
      if (gen === docGeneration) auditReport = report; // ignore a stale document's result
    } catch {
      if (gen === docGeneration) auditReport = null;
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

  // Re-render whenever the document or page changes (runs after DOM is ready).
  $effect(() => {
    void currentPage;
    if (status === 'ready') void renderCurrent();
  });

  // Tear down the last-open document's worker (and any in-flight render) when the
  // island unmounts, so navigating away doesn't leak a pdf.js worker thread.
  onDestroy(() => {
    renderTask?.cancel();
    if (doc) void doc.loadingTask.destroy().catch(() => {});
  });

  // --- file input / drag & drop ---
  function onInputChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void openFile(file);
  }
  // dragleave also fires when the pointer crosses onto a child element, which
  // would flicker the highlight; only clear it when the pointer truly left.
  function onDragLeave(e: DragEvent) {
    const to = e.relatedTarget as Node | null;
    if (!to || !(e.currentTarget as HTMLElement).contains(to)) dragOver = false;
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    // Some platforms hand over a PDF with an empty type, so fall back to the
    // extension. Anything else gets a visible reason rather than silence.
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      status = 'error';
      errorMsg = `${file.name} is not a PDF.`;
      return;
    }
    void openFile(file);
  }

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

  // The native dialog handles the whole modal contract: focus goes inside on
  // showModal() and is restored on close, Tab is trapped, the background is inert,
  // page scroll is locked, and Escape closes. A hand-rolled version of any one of
  // those is a bug waiting to happen (the previous trap leaked on the first
  // Shift+Tab, because focus started on an element its own query excluded).
  let dialogEl = $state<HTMLDialogElement>();
  $effect(() => {
    if (verifyResult) dialogEl?.showModal();
    else dialogEl?.close();
  });

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
      const bytes = await exportRedactedPdf(pristine, doc, rects);
      pendingBytes = bytes;
      // Re-check that the text we actually covered is gone from the output, not
      // just that no structural leak vectors remain. Exact search terms travel
      // on the rects; hand-drawn boxes contribute the whole runs they cover.
      const rectTerms = rects.map((r) => r.term).filter((t): t is string => Boolean(t));
      const boxText = await collectRedactedText(doc, rects);
      const redactedTerms = [...new Set([...rectTerms, ...boxText])];
      // Pass the source doc + rects so verify also re-reads the output pixels and
      // proves each redaction actually landed black over its target.
      verifyResult = await verifyExport(bytes, redactedTerms, { doc, rects });
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      exporting = false;
    }
  }

  function confirmDownload() {
    if (pendingBytes) downloadBytes(pendingBytes, redactedFileName(fileName));
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
    'rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-800 transition hover:border-neutral-400 disabled:cursor-not-allowed disabled:opacity-40';

  // Everything here happens asynchronously and is otherwise announced only by a
  // button label changing, which screen readers report unreliably. The region is
  // always mounted (one injected alongside its text is routinely missed) and the
  // ordering is most-urgent-first, so a single live area covers the whole flow.
  const liveStatus = $derived(
    status === 'loading'
      ? 'Opening file.'
      : exporting
        ? 'Exporting redacted PDF.'
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
    <!-- A real button, so the visible text is the accessible name (WCAG 2.5.3) and
         Enter/Space come from the platform. The error lives outside it: `button`
         has children-presentational semantics, so anything nested here is hidden
         from screen readers, and this is the only feedback a failed open gets. -->
    <button
      type="button"
      class="flex min-h-72 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-10 text-center transition"
      class:border-neutral-300={!dragOver}
      class:bg-white={!dragOver}
      class:border-neutral-900={dragOver}
      class:bg-neutral-100={dragOver}
      ondragover={(e) => {
        e.preventDefault();
        dragOver = true;
      }}
      ondragleave={onDragLeave}
      ondrop={onDrop}
      onclick={() => fileInput?.click()}
    >
      <span class="text-lg font-medium text-neutral-800">Drop a PDF to redact</span>
      <span class="text-sm text-neutral-600">
        or <span class="pp-click">click</span><span class="pp-tap">tap</span> to choose a file · nothing
        leaves your browser
      </span>
    </button>
    {#if status === 'error'}
      <p class="mt-3 text-center text-sm text-red-600" role="alert">
        Could not open that file: {errorMsg}
      </p>
    {/if}
    <input
      bind:this={fileInput}
      type="file"
      accept="application/pdf"
      class="sr-only"
      onchange={onInputChange}
      aria-label="Choose a PDF file"
    />
  {:else}
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <span class="max-w-56 truncate text-sm text-neutral-700">{fileName}</span>
      <span class="text-xs text-neutral-600"
        >{rects.length} redaction{rects.length === 1 ? '' : 's'}</span
      >
      <div class="ml-auto flex items-center gap-2">
        <button class={btn} onclick={undo} disabled={past.length === 0}>Undo</button>
        <button class={btn} onclick={redo} disabled={future.length === 0}>Redo</button>
        <button
          class="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
          onclick={exportPdf}
          disabled={exporting}
          >{exporting ? 'Exporting…' : rects.length === 0 ? 'Strip metadata' : 'Export'}</button
        >
        <button class={btn} onclick={reset}>New file</button>
      </div>
    </div>

    {#if errorMsg}
      <p
        class="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
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
        class="w-72 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-500 focus:border-neutral-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
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
          class="rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-semibold text-black transition hover:bg-amber-300"
          onclick={redactAllMatches}>Redact all {searchMatches.length}</button
        >
      {:else if noMatches}
        <span class="text-xs text-neutral-600">No matches</span>
      {/if}
      <button
        class={`${btn} ml-auto`}
        onclick={applyToAllPages}
        disabled={pageRects.length === 0}
        title="Copy this page's redaction boxes onto every page (repeating headers/footers)"
        >Apply page to all</button
      >
      {#if auditReport && !hasTextLayer}
        <p class="basis-full text-xs text-amber-700">
          This file has no text layer, so search can't find words. Draw boxes to redact instead.
        </p>
      {/if}
    </div>

    {#if auditReport}
      <section class={`mb-4 rounded-xl border p-4 ${auditPanelClass}`} aria-label="Document audit">
        {#if auditReport.findings.length > 0}
          <h2 class="text-sm font-semibold text-amber-800">
            This file is hiding {auditReport.findings.length} thing{auditReport.findings.length ===
            1
              ? ''
              : 's'}:
          </h2>
          <ul class="mt-2 space-y-1">
            {#each auditReport.findings as f (f.id)}
              <li class="flex items-start gap-2 text-sm text-neutral-700">
                <span
                  class={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sevClass(f.severity)}`}
                  aria-hidden="true"
                ></span>
                <span
                  ><span class="sr-only"
                    >{f.severity === 'high' ? 'High' : 'Medium'} severity:
                  </span><span class="font-medium text-neutral-900">{f.title}:</span>
                  {f.detail}</span
                >
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-sm text-neutral-600">
            ✓ No hidden metadata, annotations, attachments, or scripts found.
          </p>
        {/if}
        {#if auditReport.isLikelyScan}
          <p class="mt-2 text-xs text-amber-700">
            Looks like a scanned document (no text layer). Draw boxes over regions; flattening
            removes them safely.
          </p>
        {:else}
          <p class="mt-2 text-xs text-neutral-600">
            Has a text layer. Redacted pages are rasterized on export; untouched pages keep
            selectable text.
          </p>
        {/if}
      </section>
    {/if}

    <div class="grid grid-cols-[130px_1fr] gap-4">
      <nav class="max-h-[76vh] overflow-y-auto pr-1" aria-label="Pages">
        {#each thumbs as t (t.page)}
          <button
            class="mb-2 block w-full overflow-hidden rounded border bg-neutral-100 transition"
            class:border-neutral-900={t.page === currentPage}
            class:border-transparent={t.page !== currentPage}
            onclick={() => goTo(t.page)}
            aria-current={t.page === currentPage ? 'page' : undefined}
          >
            <img src={t.url} alt={`Page ${t.page}`} class="block w-full" />
            <span class="block py-1 text-center text-xs text-neutral-600">{t.page}</span>
          </button>
        {/each}
      </nav>

      <div bind:this={viewerEl}>
        <div class="relative inline-block">
          <canvas
            bind:this={pageCanvas}
            class="block max-w-full rounded shadow-md ring-1 ring-neutral-200"
          ></canvas>
          <!-- Intentional: role="application" drawing surface with a documented keyboard model (see #redact-kb-help). -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div
            bind:this={overlayEl}
            class="absolute inset-0 cursor-crosshair touch-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:outline-none"
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
              class="pointer-events-auto absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full bg-white text-xs font-bold text-black opacity-0 ring-neutral-900 transition group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
              onclick={(e) => {
                e.stopPropagation();
                deleteRect(r);
              }}
              aria-label="Remove redaction">×</button
            >
          {/snippet}
          <div class="pointer-events-none absolute inset-0">
            {#each pageRects as r (r)}
              {@render posBox(r, 'group absolute bg-black', deleteButton)}
            {/each}
            {#if preview}
              {@render posBox(preview, 'absolute border-2 border-neutral-900 bg-black/30')}
            {/if}
            {#each searchPreview as r, i (`s${i}`)}
              {@render posBox(r, 'absolute border-2 border-amber-400 bg-amber-400/25')}
            {/each}
          </div>
        </div>

        <div class="mt-3 flex items-center justify-center gap-3 text-sm text-neutral-700">
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
    <p class="mt-4 text-center text-sm text-neutral-600">Opening…</p>
  {/if}
</div>

<!-- Always mounted, contents gated: unmounting an open dialog would tear it out of
     the top layer without a close event, losing focus restoration. -->
<dialog
  bind:this={dialogEl}
  aria-labelledby="verify-title"
  onclose={closeVerify}
  class="m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-6 backdrop:bg-black/50"
>
  {#if verifyResult}
    <div>
      <h2 id="verify-title" class="text-lg font-semibold text-neutral-900">
        Verify before download
      </h2>
      <p class="mt-1 text-sm text-neutral-600">
        Everything below is still recoverable from the file you are about to download.
      </p>

      {#if verifyResult.clean}
        <p
          class="mt-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
        >
          ✓ No text, metadata, attachments, or scripts are recoverable, and none of your redacted
          terms survived.
        </p>
      {:else}
        <div class="mt-4 space-y-2">
          {#if verifyResult.uncoveredRegions.length > 0}
            <p class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <strong>Redaction didn't fully cover its target.</strong>
              {verifyResult.uncoveredRegions.length}
              {verifyResult.uncoveredRegions.length === 1 ? 'box' : 'boxes'} left part of the underlying
              content visible in the exported image. Don't download; widen the box (or redact the whole
              line) and export again.
            </p>
          {/if}
          {#each verifyResult.remaining as f (f.id)}
            <p class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <strong>{f.title}:</strong>
              {f.detail}
            </p>
          {/each}
          {#if verifyResult.leakedTerms.length > 0}
            <p class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <strong>Still recoverable:</strong>
              {verifyResult.leakedTerms.join(', ')}
            </p>
          {/if}
        </div>
      {/if}

      <p class="mt-3 text-xs text-amber-700">
        This re-reads the exported file: the text and hidden data left in it, and the pixels of
        every redacted page to confirm each box actually covers what's underneath. It can only check
        the text you redacted; review the recoverable text below for anything you missed.
      </p>

      <div class="mt-5">
        <h3 class="text-sm font-medium text-neutral-700">
          Recoverable text ({verifyResult.recoverableStrings.length})
        </h3>
        {#if verifyResult.recoverableStrings.length === 0}
          <p class="mt-1 text-sm text-neutral-600">None. The output has no extractable text.</p>
        {:else}
          <ul
            class="mt-2 max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-100 p-3 font-mono text-xs text-neutral-700"
          >
            {#each verifyResult.recoverableStrings as s, i (i)}
              <li class="truncate">{s}</li>
            {/each}
          </ul>
          <p class="mt-1 text-xs text-neutral-600">
            Pages you redacted became images, so their text is gone. Pages you didn't touch still
            have selectable text. Make sure nothing sensitive is listed above.
          </p>
        {/if}
      </div>

      <div class="mt-6 flex justify-end gap-3">
        <button class={btn} onclick={closeVerify}>Cancel</button>
        <button
          class="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-700"
          onclick={confirmDownload}
          >{verifyResult.clean ? 'Download redacted PDF' : 'Download anyway'}</button
        >
      </div>
    </div>
  {/if}
</dialog>
