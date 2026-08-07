<script lang="ts">
  import { downloadBytes } from '@lib/download';
  import { inspectMedia, mimeTypeFor, stripMedia, verifyMedia, type MediaFormat } from '@lib/media';
  import type { StripNote } from '@lib/media/types';
  import type { Finding } from '@lib/types';
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

  // The file bytes are large and only ever replaced wholesale, so they are kept
  // out of the reactive graph: proxying a multi-megabyte buffer to watch for
  // mutations that never happen is pure overhead.
  let original: Uint8Array | undefined;
  let cleaned: Uint8Array | undefined;

  // Object URLs for the preview. Held so they can be revoked: each one pins its
  // blob in memory until released, and a few phone videos would add up.
  let originalUrl = $state<string | undefined>();
  let cleanedUrl = $state<string | undefined>();

  const isVideo = $derived(format === 'mp4');
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
      prompt="Drop a photo or video"
      accept="image/jpeg,image/png,image/webp,video/mp4,.jpg,.jpeg,.png,.webp,.mp4,.mov,.m4v"
      inputLabel="Choose a photo or video"
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
      <span class="max-w-56 truncate text-sm text-neutral-700">{fileName}</span>
      <span class="rounded bg-neutral-200 px-2 py-0.5 text-xs text-neutral-700 uppercase"
        >{format}</span
      >
      <button
        type="button"
        class="ml-auto rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
        onclick={reset}>Open another</button
      >
    </div>

    <section
      class={`mb-4 rounded-xl border p-4 ${findings.length > 0 && status !== 'done' ? 'border-amber-300 bg-amber-50' : 'border-neutral-200 bg-white'}`}
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
        {#if isVideo}
          <!-- This plays the user's own file, which arrived seconds ago with no
               caption track and no way for us to make one. An empty <track> would
               satisfy the rule by claiming captions exist, which is worse than
               saying plainly that there are none. -->
          <!-- svelte-ignore a11y_media_has_caption -->
          <video src={previewUrl} controls class="max-h-96 w-full rounded-xl bg-neutral-900"
          ></video>
        {:else}
          <img
            src={previewUrl}
            alt={status === 'done' ? 'The cleaned file' : 'The file you opened'}
            class="max-h-96 w-full rounded-xl object-contain"
          />
        {/if}
        <figcaption class="mt-2 text-center text-xs text-neutral-600">
          {status === 'done' ? 'After cleaning' : 'Before cleaning'} · never uploaded
        </figcaption>
      </figure>
    {/if}

    {#if status === 'loaded'}
      <button
        type="button"
        class="w-full rounded-xl bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-800"
        onclick={clean}
      >
        {findings.length > 0 ? 'Remove all of it' : 'Clean it anyway'}
      </button>
    {:else if status === 'done'}
      <section
        class={`mb-4 rounded-xl border p-4 ${remaining.length === 0 ? 'border-green-300 bg-green-50' : 'border-red-300 bg-red-50'}`}
        aria-label="Verification"
      >
        {#if remaining.length === 0}
          <h2 class="text-sm font-semibold text-green-800">
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
          <p class="mt-2 text-xs text-neutral-700">
            <span class="font-medium">{note.title}:</span>
            {note.detail}
          </p>
        {/each}
      </section>

      <button
        type="button"
        class="w-full rounded-xl bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-800"
        onclick={save}>Download the clean file</button
      >
    {/if}
  {/if}
</div>
