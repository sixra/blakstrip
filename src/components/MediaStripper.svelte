<script lang="ts">
  import { downloadBytes } from '@lib/download';
  import { inspectMedia, mimeTypeFor, stripMedia, verifyMedia, type MediaFormat } from '@lib/media';
  import type { StripNote } from '@lib/media/types';
  import type { Finding } from '@lib/types';
  import { clearUnsaved, markUnsaved } from '@lib/unsaved';
  import CompressPanel from './CompressPanel.svelte';
  import DropZone from './DropZone.svelte';
  import FindingsList from './FindingsList.svelte';

  type Status = 'idle' | 'error' | 'loaded' | 'done';

  let status = $state<Status>('idle');
  let errorMsg = $state('');
  let fileName = $state('');
  let format = $state<MediaFormat | undefined>();
  let findings = $state.raw<Finding[]>([]);
  let notes = $state.raw<StripNote[]>([]);
  let remaining = $state.raw<Finding[]>([]);

  // The file bytes are large and only ever replaced wholesale, so they never go
  // through a proxy: watching a multi-megabyte buffer for mutations that never
  // happen is pure overhead. `cleaned` is `$state.raw` rather than a plain
  // variable only because the compression panel is handed it as a prop.
  let original: Uint8Array | undefined;
  let cleaned = $state.raw<Uint8Array | undefined>();

  // Object URLs for the preview. Held so they can be revoked: each one pins its
  // blob in memory until released.
  let originalUrl = $state<string | undefined>();
  let cleanedUrl = $state<string | undefined>();

  const previewUrl = $derived(cleanedUrl ?? originalUrl);

  function releaseUrls(): void {
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    if (cleanedUrl) URL.revokeObjectURL(cleanedUrl);
    originalUrl = undefined;
    cleanedUrl = undefined;
  }

  function reset(): void {
    releaseUrls();
    original = undefined;
    cleaned = undefined;
    findings = [];
    notes = [];
    remaining = [];
    format = undefined;
    fileName = '';
    status = 'idle';
    errorMsg = '';
    clearUnsaved('media-strip');
  }

  function describe(error: unknown): string {
    // The message is ours (MalformedFileError, UnsupportedFormatError), never
    // the file's contents, so showing it leaks nothing.
    return error instanceof Error ? error.message : 'the file could not be read';
  }

  async function openFile(file: File): Promise<void> {
    reset();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const audit = inspectMedia(bytes);

      original = bytes;
      fileName = file.name;
      format = audit.format;
      findings = audit.findings;
      originalUrl = URL.createObjectURL(new Blob([bytes], { type: mimeTypeFor(audit.format) }));
      status = 'loaded';
      // See Redactor: a reload from here loses the photo and anything done to it.
      markUnsaved('media-strip');
    } catch (error) {
      status = 'error';
      errorMsg = describe(error);
    }
  }

  function clean(): void {
    if (!original || !format) return;
    try {
      const result = stripMedia(original);
      const report = verifyMedia(result.bytes);

      cleaned = result.bytes;
      notes = result.notes;
      remaining = report.remaining;
      cleanedUrl = URL.createObjectURL(
        new Blob([result.bytes as BlobPart], { type: mimeTypeFor(format) })
      );
      status = 'done';
    } catch (error) {
      status = 'error';
      errorMsg = describe(error);
    }
  }

  function save(): void {
    if (!cleaned || !format) return;
    const dot = fileName.lastIndexOf('.');
    const name =
      dot > 0 ? `${fileName.slice(0, dot)}-clean${fileName.slice(dot)}` : `${fileName}-clean`;
    downloadBytes(cleaned, name, mimeTypeFor(format));
  }

  const liveStatus = $derived(
    status === 'loaded'
      ? `Opened ${fileName}. Found ${findings.length} thing${findings.length === 1 ? '' : 's'}.`
      : status === 'done'
        ? remaining.length === 0
          ? 'Cleaned and verified. Nothing left to find.'
          : `Cleaned, but ${remaining.length} item${remaining.length === 1 ? '' : 's'} could not be removed.`
        : ''
  );
</script>

<svelte:window onbeforeunload={releaseUrls} />

<div class="mx-auto w-full max-w-3xl">
  <p class="sr-only" role="status" aria-live="polite">{liveStatus}</p>

  {#if status === 'idle' || status === 'error'}
    <DropZone
      error={status === 'error' ? errorMsg : ''}
      prompt="Drop a photo"
      accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
      inputLabel="Choose a photo"
      validate={(file) =>
        // Checked here only to fail fast on an obvious mismatch. The real
        // decision is made from the bytes once the file is read, because a name
        // and a declared type are both supplied by whoever made the file.
        file.size > 0 ? undefined : `${file.name} is empty.`}
      onFile={(file) => void openFile(file)}
      onReject={(reason) => {
        status = 'error';
        errorMsg = reason;
      }}
    />
  {:else}
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <span class="text-muted max-w-56 truncate text-sm">{fileName}</span>
      <span class="bg-line text-muted rounded px-2 py-0.5 text-xs uppercase">{format}</span>
      <button
        type="button"
        class="border-line hover:bg-line ml-auto rounded-lg border px-3 py-1.5 text-sm"
        onclick={reset}>Open another</button
      >
    </div>

    <section
      class={`mb-4 rounded-xl border p-4 ${findings.length > 0 && status !== 'done' ? 'border-warning bg-warning-surface' : 'border-line bg-raised'}`}
      aria-label="File audit"
    >
      <FindingsList
        {findings}
        heading={(count) =>
          // Past tense once the strip has run. Leaving it in the present tense
          // put "this file is carrying 1 thing" directly under "verified clean",
          // which reads as the tool contradicting itself.
          status === 'done'
            ? `Removed ${count} thing${count === 1 ? '' : 's'}:`
            : `This file is carrying ${count} thing${count === 1 ? '' : 's'}:`}
        emptyMessage="✓ Nothing identifying found in this file."
      />
    </section>

    {#if previewUrl}
      <figure class="mb-4">
        <img
          src={previewUrl}
          alt={status === 'done' ? 'The cleaned file' : 'The file you opened'}
          class="max-h-96 w-full rounded-xl object-contain"
        />
        <figcaption class="text-muted mt-2 text-center text-xs">
          {status === 'done' ? 'After cleaning' : 'Before cleaning'} · never uploaded
        </figcaption>
      </figure>
    {/if}

    {#if status === 'loaded'}
      <button
        type="button"
        class="bg-redact text-surface hover:bg-ink w-full rounded-xl px-4 py-3 font-medium"
        onclick={clean}
      >
        {findings.length > 0 ? 'Remove all of it' : 'Clean it anyway'}
      </button>
    {:else if status === 'done'}
      <section
        class={`mb-4 rounded-xl border p-4 ${remaining.length === 0 ? 'border-positive bg-positive-surface' : 'border-danger bg-danger-surface'}`}
        aria-label="Verification"
      >
        {#if remaining.length === 0}
          <h2 class="text-positive text-sm font-semibold">
            Verified clean. We re-read the finished file and found nothing.
          </h2>
        {:else}
          <FindingsList
            findings={remaining}
            heading={(count) => `${count} thing${count === 1 ? '' : 's'} could not be removed:`}
            emptyMessage=""
          />
        {/if}
        {#each notes as note (note.id)}
          <p class="text-muted mt-2 text-xs">
            <span class="font-medium">{note.title}:</span>
            {note.detail}
          </p>
        {/each}
      </section>

      <button
        type="button"
        class="bg-redact text-surface hover:bg-ink w-full rounded-xl px-4 py-3 font-medium"
        onclick={save}>Download the clean file</button
      >

      {#if cleaned && format}
        <div class="mt-6">
          <CompressPanel bytes={cleaned} {format} {fileName} sourceUrl={cleanedUrl} />
        </div>
      {/if}
    {/if}
  {/if}
</div>
