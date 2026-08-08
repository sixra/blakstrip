<script lang="ts">
  import { downloadBytes } from '@lib/download';
  import { verifyMedia, type MediaFormat } from '@lib/media';
  import {
    compressedFileName,
    optionsForPreset,
    outputMimeType,
    percentSaved,
    type CompressOptions,
    type CompressPreset,
    type OutputFormat,
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

  const FORMATS: OutputFormat[] = ['jpeg', 'png', 'webp', 'avif'];

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
  /** False for a format this app can write but not read back. */
  let wasVerified = $state(true);
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
      // AVIF is the exception, and it is stated plainly in the UI rather than
      // quietly skipped. This app has no AVIF parser, so `verifyMedia` would
      // throw "unsupported file" at the person who chose it. The encode is still
      // from raw pixels, so the claim holds; what is missing is the proof, and
      // pretending otherwise would undercut the one thing this tool sells.
      //
      // Everything is computed before any of it is displayed. Assigning as we go
      // meant a throw here left the results panel half updated: a size and a
      // percentage on screen next to an error, with the previous preview already
      // revoked and no new one to replace it.
      const readable = result.format !== 'avif';
      const verified = readable ? verifyMedia(result.bytes).remaining : [];
      const url = URL.createObjectURL(
        new Blob([result.bytes as BlobPart], { type: outputMimeType(result.format) })
      );

      releaseCompressed();
      compressed = result.bytes;
      compressedSize = result.bytes.length;
      compressedDims = { width: result.width, height: result.height };
      remaining = verified;
      wasVerified = readable;
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
    downloadBytes(compressed, outputName, outputMimeType(options.format));
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

<section class="border-line bg-raised rounded-xl border p-4" aria-label="Compression">
  <h2 class="text-ink text-sm font-semibold">Make it smaller</h2>
  <p class="text-muted mt-1 text-xs">
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
            ? 'border-redact bg-redact text-surface'
            : 'border-line hover:bg-line'
        }`}
        onclick={() => choosePreset(option.id)}
      >
        <span class="block font-medium">{option.label}</span>
        <span
          class={`block text-xs ${activePreset === option.id ? 'text-surface/70' : 'text-muted'}`}
          >{option.hint}</span
        >
      </button>
    {/each}
  </div>

  <details class="mt-3">
    <summary class="text-muted cursor-pointer text-xs">Settings</summary>

    <div class="mt-3 grid gap-4 sm:grid-cols-2">
      <div class="flex flex-col gap-1">
        <label class="text-muted text-xs font-medium" for="compress-format">Save as</label>
        <select
          id="compress-format"
          class="border-line rounded-lg border px-2 py-1.5 text-sm"
          value={options.format}
          onchange={(event) => update({ format: event.currentTarget.value as OutputFormat })}
        >
          {#each FORMATS as value (value)}
            <option {value}>
              {value.toUpperCase()}{value === 'avif' ? ' · smallest, much slower' : ''}
            </option>
          {/each}
        </select>
      </div>

      {#if options.format === 'png'}
        <div class="flex flex-col gap-1">
          <label class="text-muted text-xs font-medium" for="compress-effort">
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
          <span id="compress-effort-hint" class="text-muted text-xs">
            PNG is lossless, so this only trades time for size. No pixel changes.
          </span>
        </div>
      {:else}
        <div class="flex flex-col gap-1">
          <label class="text-muted text-xs font-medium" for="compress-quality">
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
        <label class="text-muted text-xs font-medium" for="compress-max"> Longest side </label>
        <select
          id="compress-max"
          class="border-line rounded-lg border px-2 py-1.5 text-sm"
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
        <span id="compress-max-hint" class="text-muted text-xs">
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
    <p class="border-danger bg-danger-surface text-danger mt-3 rounded-lg border p-3 text-sm">
      {errorMsg}
    </p>
  {/if}

  {#if busy}
    <p class="text-muted mt-3 text-sm">
      Compressing…{#if options.format === 'avif'}
        AVIF takes far longer than the others: about 20 seconds for a photo straight off a phone.
      {/if}
    </p>
  {/if}

  {#if compressedSize > 0}
    <div class={`mt-4 ${busy ? 'opacity-60' : ''}`}>
      <dl class="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <div class="flex gap-2">
          <dt class="text-muted">Before</dt>
          <dd class="font-medium">{formatBytes(bytes.length)}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-muted">After</dt>
          <dd class="font-medium">{formatBytes(compressedSize)}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-muted">{saved >= 0 ? 'Saved' : 'Grew by'}</dt>
          <dd class={`font-medium ${saved >= 0 ? 'text-positive' : 'text-warning'}`}>
            {Math.abs(saved)}%
          </dd>
        </div>
        {#if compressedDims}
          <div class="flex gap-2">
            <dt class="text-muted">Size</dt>
            <dd class="font-medium">{compressedDims.width} × {compressedDims.height}</dd>
          </div>
        {/if}
      </dl>

      {#if saved < 0}
        <p class="text-warning mt-2 text-xs">
          This came out larger than the original. That happens when a file is already well
          compressed, or when a flat-colour image is saved as a photo format. Try a lower quality or
          a different format.
        </p>
      {/if}

      <figure class="mt-3">
        <!-- tabindex and role are here because this scrolls. Judging compression
             artefacts means panning around a full-size image, and without a
             focusable container that is mouse-only: axe flags it as
             scrollable-region-focusable, and a keyboard user simply cannot see
             most of the picture they are being asked to evaluate. -->
        <div
          class="border-line bg-line focus-visible:ring-redact max-h-96 overflow-auto rounded-xl border focus-visible:ring-2 focus-visible:outline-none"
          tabindex="0"
          role="group"
          aria-label={showOriginal
            ? 'The picture before compressing, at full size. Scroll to pan.'
            : 'The compressed picture, at full size. Scroll to pan.'}
        >
          <img
            src={showOriginal ? sourceUrl : compressedUrl}
            alt={showOriginal ? 'The picture before compressing' : 'The compressed picture'}
            class="max-w-none"
          />
        </div>
        <figcaption
          class="text-muted mt-2 flex flex-wrap items-center justify-between gap-2 text-xs"
        >
          <span>
            Shown at full size, so scroll to judge the detail. A shrunken preview hides exactly the
            artefacts worth looking at.
          </span>
          <button
            type="button"
            aria-pressed={showOriginal}
            class="border-line hover:bg-line rounded-lg border px-2 py-1"
            onclick={() => (showOriginal = !showOriginal)}
          >
            {showOriginal ? 'Show compressed' : 'Compare with original'}
          </button>
        </figcaption>
      </figure>

      <p
        class={`mt-3 rounded-lg border p-3 text-sm ${
          remaining.length === 0
            ? 'border-positive bg-positive-surface text-positive'
            : 'border-danger bg-danger-surface text-danger'
        }`}
      >
        {!wasVerified
          ? 'Encoded from raw pixels, so nothing was carried over. This is the one format blakstrip cannot read back, so unlike the others it is not re-checked here.'
          : remaining.length === 0
            ? 'Re-read the compressed file: still nothing identifying in it.'
            : `${remaining.length} thing${remaining.length === 1 ? '' : 's'} survived into the compressed file.`}
      </p>

      <button
        type="button"
        class="bg-redact text-surface hover:bg-ink mt-3 w-full rounded-xl px-4 py-3 font-medium disabled:opacity-60"
        disabled={busy}
        onclick={save}
      >
        Download the smaller file
      </button>
    </div>
  {/if}
</section>
