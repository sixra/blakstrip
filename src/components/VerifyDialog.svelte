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
    'rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-800 transition hover:border-neutral-400';
  const alert = 'rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700';
</script>

<!-- Always mounted, contents gated: unmounting an open dialog would tear it out
     of the top layer without a close event, losing focus restoration. -->
<dialog
  bind:this={dialogEl}
  aria-labelledby="verify-title"
  onclose={onCancel}
  class="m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-6 backdrop:bg-black/50"
>
  {#if report}
    <div>
      <h2 id="verify-title" class="text-lg font-semibold text-neutral-900">
        Verify before download
      </h2>
      <p class="mt-1 text-sm text-neutral-600">
        Everything below is still recoverable from the file you are about to download.
      </p>

      {#if report.clean}
        <p
          class="mt-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
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
              class="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
            >
              <strong>Also on {s.pages.length === 1 ? 'a page' : 'pages'} you didn't redact:</strong
              >
              “{s.term}” is covered where you boxed it, but still readable on page
              {s.pages.join(', ')}. Redact it there too, or leave it if it isn't sensitive there.
            </p>
          {/each}
        </div>
      {/if}

      <p class="mt-3 text-xs text-amber-700">
        This re-reads the exported file: the text and hidden data left in it, and the pixels of
        every redacted page to confirm each box actually covers what's underneath. It can only check
        the text you redacted; review the recoverable text below for anything you missed.
      </p>

      <div class="mt-5">
        <h3 class="text-sm font-medium text-neutral-700">
          Recoverable text ({report.recoverableStrings.length})
        </h3>
        {#if report.recoverableStrings.length === 0}
          <p class="mt-1 text-sm text-neutral-600">None. The output has no extractable text.</p>
        {:else}
          <ul
            class="mt-2 max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-100 p-3 font-mono text-xs text-neutral-700"
          >
            {#each report.recoverableStrings as s, i (i)}
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
        <button class={btn} onclick={onCancel}>Cancel</button>
        <button
          class="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-700"
          onclick={onDownload}>{report.clean ? 'Download redacted PDF' : 'Download anyway'}</button
        >
      </div>
    </div>
  {/if}
</dialog>
