<script lang="ts">
  import { mimeTypeFor, requireFormat, type MediaFormat } from '@lib/media';
  import { clearUnsaved, markUnsaved } from '@lib/unsaved';
  import CompressPanel from './CompressPanel.svelte';
  import DropZone from './DropZone.svelte';

  type Status = 'idle' | 'error' | 'loaded';

  let status = $state<Status>('idle');
  let errorMsg = $state('');
  let fileName = $state('');
  let format = $state<MediaFormat | undefined>();

  // Large and only ever replaced wholesale, so no proxy: watching a
  // multi-megabyte buffer for mutations that never happen is pure overhead.
  // Raw rather than plain because the panel takes it as a prop.
  let original = $state.raw<Uint8Array | undefined>();

  // Held so it can be revoked: the URL pins its blob in memory until released.
  let originalUrl = $state<string | undefined>();

  function releaseUrl(): void {
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    originalUrl = undefined;
  }

  // The drop zone stays mounted while a file is being read, so a second file can
  // start loading before the first finishes. Only the newest may write state:
  // the panel compresses once on mount and is not re-run by a changed prop, so a
  // late writer would leave one file's name and size beside another's bytes.
  let generation = 0;

  function reset(): void {
    generation += 1;
    releaseUrl();
    original = undefined;
    format = undefined;
    fileName = '';
    // Unmounting the panel is what frees the codecs: its teardown terminates the
    // worker, so there is nothing to tear down here.
    status = 'idle';
    errorMsg = '';
    clearUnsaved('image-compress');
  }

  function describe(error: unknown): string {
    // The message is ours (UnsupportedFormatError), never the file's contents, so
    // showing it leaks nothing.
    return error instanceof Error ? error.message : 'the file could not be read';
  }

  async function openFile(file: File): Promise<void> {
    reset();
    const mine = generation;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (mine !== generation) return;

      // Identified, not audited. `inspectMedia` walks the whole container and
      // refuses anything malformed, which would turn away files the browser's
      // own decoder opens happily; here the decoder is the arbiter. Nothing is
      // lost by skipping it: re-encoding starts from raw pixels, so metadata
      // cannot survive, and the panel proves that by re-reading its output.
      format = requireFormat(bytes);

      original = bytes;
      fileName = file.name;
      originalUrl = URL.createObjectURL(new Blob([bytes], { type: mimeTypeFor(format) }));
      status = 'loaded';
      // A reload from here loses the picture and whatever was encoded from it.
      markUnsaved('image-compress');
    } catch (error) {
      status = 'error';
      errorMsg = describe(error);
    }
  }

  const liveStatus = $derived(status === 'loaded' ? `Opened ${fileName}. Compressing.` : '');
</script>

<svelte:window onbeforeunload={releaseUrl} />

<div class="mx-auto w-full max-w-3xl">
  <p class="sr-only" role="status" aria-live="polite">{liveStatus}</p>

  {#if status === 'idle' || status === 'error'}
    <DropZone
      error={status === 'error' ? errorMsg : ''}
      prompt="Drop a picture"
      accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
      inputLabel="Choose a picture"
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

    {#if original && format}
      <CompressPanel bytes={original} {format} {fileName} sourceUrl={originalUrl} />
    {/if}
  {/if}
</div>
