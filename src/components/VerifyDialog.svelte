<script lang="ts">
  import type { VerifyReport } from '@lib/pdf/types';

  interface Props {
    /** Non-null opens the dialog; null closes it. */
    report: VerifyReport | null;
    onCancel: () => void;
    onDownload: () => void;
  }

  const { report, onCancel, onDownload }: Props = $props();

  // The native dialog handles the whole modal contract: focus moves inside on
  // showModal() and is restored on close, Tab is trapped, the background is
  // inert, page scroll is locked, and Escape closes. Hand-rolling any one of
  // those is a bug waiting to happen.
  let dialogEl = $state<HTMLDialogElement>();
  $effect(() => {
    if (report) dialogEl?.showModal();
    else dialogEl?.close();
  });

  const btn =
    'rounded-lg border border-line px-3 py-1.5 text-sm text-ink transition hover:border-line-strong';
  const alert =
    'rounded-lg border border-danger/40 bg-danger-surface px-3 py-2 text-sm text-danger';
</script>

<!-- Always mounted, contents gated: unmounting an open dialog would tear it out
     of the top layer without a close event, losing focus restoration. -->
<dialog
  bind:this={dialogEl}
  aria-labelledby="verify-title"
  onclose={onCancel}
  class="border-line bg-raised backdrop:bg-scrim/50 m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl border p-6"
>
  {#if report}
    <div>
      <h2 id="verify-title" class="text-ink text-lg font-semibold">Verify before download</h2>
      <p class="text-muted mt-1 text-sm">
        Everything below is still recoverable from the file you are about to download.
      </p>

      {#if report.clean}
        <p
          class="border-positive/40 bg-positive-surface text-positive mt-4 rounded-lg border px-3 py-2 text-sm"
        >
          ✓ No text, metadata, attachments, or scripts are recoverable, and none of your redacted
          terms survived.
        </p>
      {:else}
        <div class="mt-4 space-y-2">
          {#if report.uncoveredRegions.length > 0}
            <p class={alert}>
              <strong>Redaction didn't fully cover its target.</strong>
              {report.uncoveredRegions.length}
              {report.uncoveredRegions.length === 1 ? 'box' : 'boxes'} left part of the underlying content
              visible in the exported image. Don't download; widen the box (or redact the whole line)
              and export again.
            </p>
          {/if}
          {#each report.remaining as f (f.id)}
            <p class={alert}>
              <strong>{f.title}:</strong>
              {f.detail}
              {#if f.id === 'exif'}
                To remove it, cancel and draw a redaction box anywhere on the page holding that
                image: flattening the page re-encodes the image and drops the EXIF with it.
              {/if}
            </p>
          {/each}
          {#if report.leakedTerms.length > 0}
            <p class={alert}>
              <strong>Still recoverable:</strong>
              {report.leakedTerms.join(', ')}
            </p>
          {/if}
          <!-- Not a failed redaction: the box worked, the same words simply appear
               again on a page the user left alone. Separated so the remedy reads
               as an instruction rather than another alarm. -->
          {#each report.survivingElsewhere as s (s.term)}
            <p
              class="border-warning bg-warning-surface text-warning rounded-lg border px-3 py-2 text-sm"
            >
              <strong>Also on {s.pages.length === 1 ? 'a page' : 'pages'} you didn't redact:</strong
              >
              “{s.term}” is covered where you boxed it, but still readable on page
              {s.pages.join(', ')}. Redact it there too, or leave it if it isn't sensitive there.
            </p>
          {/each}
        </div>
      {/if}

      <p class="text-warning mt-3 text-xs">
        This re-reads the exported file: the text and hidden data left in it, and the pixels of
        every redacted page to confirm each box actually covers what's underneath. It can only check
        the text you redacted; review the recoverable text below for anything you missed.
      </p>

      <div class="mt-5">
        <h3 class="text-muted text-sm font-medium">
          Recoverable text ({report.recoverableStrings.length})
        </h3>
        {#if report.recoverableStrings.length === 0}
          <p class="text-muted mt-1 text-sm">None. The output has no extractable text.</p>
        {:else}
          <ul
            class="border-line bg-line text-muted mt-2 max-h-48 space-y-0.5 overflow-y-auto rounded-lg border p-3 font-mono text-xs"
          >
            {#each report.recoverableStrings as s, i (i)}
              <li class="truncate">{s}</li>
            {/each}
          </ul>
          <p class="text-muted mt-1 text-xs">
            Pages you redacted became images, so their text is gone. Pages you didn't touch still
            have selectable text. Make sure nothing sensitive is listed above.
          </p>
        {/if}
      </div>

      <div class="mt-6 flex justify-end gap-3">
        <button class={btn} onclick={onCancel}>Cancel</button>
        <button
          class="bg-redact text-surface rounded-lg px-4 py-2 text-sm font-semibold transition hover:opacity-90"
          onclick={onDownload}>{report.clean ? 'Download redacted PDF' : 'Download anyway'}</button
        >
      </div>
    </div>
  {/if}
</dialog>
