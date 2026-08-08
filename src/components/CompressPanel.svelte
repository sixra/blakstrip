<script lang="ts">
  import { downloadBytes } from '@lib/download';
  import { mimeTypeFor, verifyMedia, type MediaFormat } from '@lib/media';
  import {
    compressedFileName,
    optionsForPreset,
    percentSaved,
    type CompressOptions,
    type CompressPreset,
  } from '@lib/media/compress';
  import { Compressor, SupersededError } from '@lib/media/compressor';
  import type { Finding } from '@lib/types';

  interface Props {
    /** The bytes to compress, already stripped. */
    bytes: Uint8Array;
    format: MediaFormat;
    fileName: string;
    /**
     * An object URL for `bytes`, owned by the parent. Passed in rather than made
     * here: the parent already holds one to show the cleaned file, and a second
     * URL for identical bytes would pin the same blob in memory twice and need
     * its own release.
     */
    sourceUrl: string | undefined;
  }

  const { bytes, format, fileName, sourceUrl }: Props = $props();

  const PRESETS: { id: CompressPreset; label: string; hint: string }[] = [
    { id: 'smallest', label: 'Smallest', hint: 'WebP, capped at 2048px' },
    { id: 'balanced', label: 'Balanced', hint: 'Same format, good quality' },
    { id: 'best', label: 'Best quality', hint: 'Barely visible change' },
  ];

  const FORMATS: MediaFormat[] = ['jpeg', 'png', 'webp'];

  let preset = $state<CompressPreset>('balanced');

  /**
   * Hand-edited settings, once there are any.
   *
   * The settled options are derived rather than stored, so they follow the format
   * prop instead of freezing whatever it was when this panel first rendered.
   * Storing them meant reading `format` during initialisation, which captures one
   * value and never updates.
   *
   * `.raw`: replaced wholesale, never mutated in place, so a deep proxy would
   * have nothing to observe. It also keeps the object structured-cloneable, which
   * matters because it crosses into the worker.
   */
  let edited = $state.raw<CompressOptions | undefined>();
  const options = $derived(edited ?? optionsForPreset(preset, format));

  /**
   * Which preset button reads as selected, which is none once the settings have
   * been touched: the controls no longer describe the preset they started from,
   * and leaving it highlighted claims otherwise. `preset` itself is kept, because
   * it is what the settings fall back to when an edit is undone.
   */
  const activePreset = $derived(edited ? undefined : preset);

  let busy = $state(false);
  let errorMsg = $state('');
  let showOriginal = $state(false);

  let compressedSize = $state(0);
  let compressedDims = $state<{ width: number; height: number } | undefined>();
  let remaining = $state.raw<Finding[]>([]);

  // Same reasoning as MediaStripper: multi-megabyte buffers are replaced
  // wholesale, so proxying them to watch for mutations that never happen is
  // pure overhead.
  let compressed: Uint8Array | undefined;
  let compressedUrl = $state<string | undefined>();

  const compressor = new Compressor();

  const saved = $derived(compressedSize > 0 ? percentSaved(bytes.length, compressedSize) : 0);
  const outputName = $derived(compressedFileName(fileName, options.format));

  function formatBytes(count: number): string {
    if (count < 1024) return `${count} B`;
    if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
    return `${(count / (1024 * 1024)).toFixed(2)} MB`;
  }

  function releaseCompressed(): void {
    if (compressedUrl) URL.revokeObjectURL(compressedUrl);
    compressedUrl = undefined;
  }

  async function run(): Promise<void> {
    busy = true;
    errorMsg = '';
    try {
      const result = await compressor.compress(bytes, format, options);

      // The output is re-encoded from raw pixels, so no metadata can survive by
      // construction. Re-reading it anyway is the point of the tool: a claim you
      // are asked to take on faith is worth less than one you can check.
      //
      // Everything is computed before any of it is displayed. Assigning as we go
      // meant a throw here left the results panel half updated: a size and a
      // percentage on screen next to an error, with the previous preview already
      // revoked and no new one to replace it.
      const verified = verifyMedia(result.bytes).remaining;
      const url = URL.createObjectURL(
        new Blob([result.bytes as BlobPart], { type: mimeTypeFor(result.format) })
      );

      releaseCompressed();
      compressed = result.bytes;
      compressedSize = result.bytes.length;
      compressedDims = { width: result.width, height: result.height };
      remaining = verified;
      compressedUrl = url;
      busy = false;
    } catch (error) {
      // A newer request replaced this one. Its own result is still coming, and
      // `busy` belongs to that request now, so leave both alone.
      if (error instanceof SupersededError) return;
      busy = false;
      errorMsg = error instanceof Error ? error.message : 'the image could not be compressed';
    }
  }

  function choosePreset(id: CompressPreset): void {
    preset = id;
    edited = undefined;
    void run();
  }

  function update(patch: Partial<CompressOptions>): void {
    edited = { ...options, ...patch };
    void run();
  }

  function save(): void {
    if (!compressed) return;
    downloadBytes(compressed, outputName, mimeTypeFor(options.format));
  }

  $effect(() => () => {
    // Teardown only, and deliberately not via `releaseCompressed`: this runs as
    // the component is destroyed, where writing to state is pointless at best.
    // The worker pins wasm memory that never shrinks, so it is ended rather than
    // left for the next file to inherit.
    compressor.dispose();
    if (compressedUrl) URL.revokeObjectURL(compressedUrl);
  });

  // Compress once on open with the default preset. Someone who reached this panel
  // came to make the file smaller, and showing three buttons and no result asks
  // them to guess what the presets do before seeing any of them.
  void run();
</script>

<section class="rounded-xl border border-neutral-200 bg-white p-4" aria-label="Compression">
  <h2 class="text-sm font-semibold text-neutral-900">Make it smaller</h2>
  <p class="mt-1 text-xs text-neutral-600">
    Re-encodes the picture in your browser. Nothing is uploaded, and the result is checked for
    metadata again afterwards.
  </p>

  <div class="mt-3 flex flex-wrap gap-2" role="group" aria-label="Compression presets">
    {#each PRESETS as option (option.id)}
      <button
        type="button"
        aria-pressed={activePreset === option.id}
        class={`rounded-lg border px-3 py-2 text-left text-sm ${
          activePreset === option.id
            ? 'border-neutral-900 bg-neutral-900 text-white'
            : 'border-neutral-300 hover:bg-neutral-100'
        }`}
        onclick={() => choosePreset(option.id)}
      >
        <span class="block font-medium">{option.label}</span>
        <span
          class={`block text-xs ${activePreset === option.id ? 'text-neutral-300' : 'text-neutral-600'}`}
          >{option.hint}</span
        >
      </button>
    {/each}
  </div>

  <details class="mt-3">
    <summary class="cursor-pointer text-xs text-neutral-700">Settings</summary>

    <div class="mt-3 grid gap-4 sm:grid-cols-2">
      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-neutral-700" for="compress-format">Save as</label>
        <select
          id="compress-format"
          class="rounded-lg border border-neutral-300 px-2 py-1.5 text-sm"
          value={options.format}
          onchange={(event) => update({ format: event.currentTarget.value as MediaFormat })}
        >
          {#each FORMATS as value (value)}
            <option {value}>{value.toUpperCase()}</option>
          {/each}
        </select>
      </div>

      {#if options.format === 'png'}
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-neutral-700" for="compress-effort">
            Effort: {options.effort}
          </label>
          <input
            id="compress-effort"
            type="range"
            min="0"
            max="6"
            step="1"
            value={options.effort}
            aria-describedby="compress-effort-hint"
            oninput={(event) => update({ effort: event.currentTarget.valueAsNumber })}
          />
          <span id="compress-effort-hint" class="text-xs text-neutral-600">
            PNG is lossless, so this only trades time for size. No pixel changes.
          </span>
        </div>
      {:else}
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-neutral-700" for="compress-quality">
            Quality: {options.quality}
          </label>
          <input
            id="compress-quality"
            type="range"
            min="1"
            max="100"
            step="1"
            value={options.quality}
            oninput={(event) => update({ quality: event.currentTarget.valueAsNumber })}
          />
        </div>
      {/if}

      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-neutral-700" for="compress-max">
          Longest side
        </label>
        <select
          id="compress-max"
          class="rounded-lg border border-neutral-300 px-2 py-1.5 text-sm"
          value={String(options.maxDimension ?? '')}
          aria-describedby="compress-max-hint"
          onchange={(event) =>
            update({
              maxDimension: event.currentTarget.value
                ? Number(event.currentTarget.value)
                : undefined,
            })}
        >
          <option value="">Leave as it is</option>
          <option value="1024">1024 px</option>
          <option value="1600">1600 px</option>
          <option value="2048">2048 px</option>
          <option value="3200">3200 px</option>
        </select>
        <span id="compress-max-hint" class="text-xs text-neutral-600">
          Smaller pictures are never enlarged to reach this.
        </span>
      </div>
    </div>
  </details>

  <p class="sr-only" role="status" aria-live="polite">
    {busy
      ? 'Compressing.'
      : compressedSize > 0
        ? `Compressed to ${formatBytes(compressedSize)}, ${saved} percent smaller.`
        : ''}
  </p>

  {#if errorMsg}
    <p class="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
      {errorMsg}
    </p>
  {/if}

  {#if busy && compressedSize === 0}
    <p class="mt-3 text-sm text-neutral-600">Compressing…</p>
  {/if}

  {#if compressedSize > 0}
    <div class={`mt-4 ${busy ? 'opacity-60' : ''}`}>
      <dl class="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <div class="flex gap-2">
          <dt class="text-neutral-600">Before</dt>
          <dd class="font-medium">{formatBytes(bytes.length)}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-neutral-600">After</dt>
          <dd class="font-medium">{formatBytes(compressedSize)}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-neutral-600">{saved >= 0 ? 'Saved' : 'Grew by'}</dt>
          <dd class={`font-medium ${saved >= 0 ? 'text-green-700' : 'text-amber-700'}`}>
            {Math.abs(saved)}%
          </dd>
        </div>
        {#if compressedDims}
          <div class="flex gap-2">
            <dt class="text-neutral-600">Size</dt>
            <dd class="font-medium">{compressedDims.width} × {compressedDims.height}</dd>
          </div>
        {/if}
      </dl>

      {#if saved < 0}
        <p class="mt-2 text-xs text-amber-800">
          This came out larger than the original. That happens when a file is already well
          compressed, or when a flat-colour image is saved as a photo format. Try a lower quality or
          a different format.
        </p>
      {/if}

      <figure class="mt-3">
        <div class="max-h-96 overflow-auto rounded-xl border border-neutral-200 bg-neutral-100">
          <img
            src={showOriginal ? sourceUrl : compressedUrl}
            alt={showOriginal ? 'The picture before compressing' : 'The compressed picture'}
            class="max-w-none"
          />
        </div>
        <figcaption
          class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-600"
        >
          <span>
            Shown at full size, so scroll to judge the detail. A shrunken preview hides exactly the
            artefacts worth looking at.
          </span>
          <button
            type="button"
            aria-pressed={showOriginal}
            class="rounded-lg border border-neutral-300 px-2 py-1 hover:bg-neutral-100"
            onclick={() => (showOriginal = !showOriginal)}
          >
            {showOriginal ? 'Show compressed' : 'Compare with original'}
          </button>
        </figcaption>
      </figure>

      <p
        class={`mt-3 rounded-lg border p-3 text-sm ${
          remaining.length === 0
            ? 'border-green-300 bg-green-50 text-green-800'
            : 'border-red-300 bg-red-50 text-red-800'
        }`}
      >
        {remaining.length === 0
          ? 'Re-read the compressed file: still nothing identifying in it.'
          : `${remaining.length} thing${remaining.length === 1 ? '' : 's'} survived into the compressed file.`}
      </p>

      <button
        type="button"
        class="mt-3 w-full rounded-xl bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
        disabled={busy}
        onclick={save}
      >
        Download the smaller file
      </button>
    </div>
  {/if}
</section>
