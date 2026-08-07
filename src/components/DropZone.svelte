<script lang="ts">
  interface Props {
    /** Shown below the zone when the last attempt failed. */
    error: string;
    /** Prompt inside the zone, e.g. "Drop a PDF to redact". */
    prompt: string;
    /** `accept` for the file input, e.g. "application/pdf" or "image/*,video/mp4". */
    accept: string;
    /** Accessible name for the hidden input. */
    inputLabel: string;
    /**
     * Reject a file before it reaches `onFile`, returning why. The check lives
     * with the caller because only it knows what it can open: the PDF tool takes
     * one type, the media tool takes four, and neither can be inferred from
     * `accept`, which browsers treat as a filter rather than a guarantee.
     */
    validate: (file: File) => string | undefined;
    onFile: (file: File) => void;
    onReject: (reason: string) => void;
  }

  const { error, prompt, accept, inputLabel, validate, onFile, onReject }: Props = $props();

  let dragOver = $state(false);
  let fileInput = $state<HTMLInputElement>();

  function offer(file: File): void {
    const reason = validate(file);
    if (reason) {
      onReject(reason);
      return;
    }
    onFile(file);
  }

  // dragleave also fires when the pointer crosses onto a child element, which
  // would flicker the highlight; only clear it when the pointer truly left.
  function onDragLeave(e: DragEvent): void {
    const to = e.relatedTarget as Node | null;
    if (!to || !(e.currentTarget as HTMLElement).contains(to)) dragOver = false;
  }
  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragOver = false;
    const file = e.dataTransfer?.files?.[0];
    if (file) offer(file);
  }
  function onInputChange(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) offer(file);
    // Cleared so choosing the same file twice still fires a change event, which
    // matters after a rejection: the obvious retry is to pick it again.
    input.value = '';
  }
</script>

<!-- The width lives here rather than in each tool's own container, so both drop
     zones are the same size. The PDF tool works at max-w-6xl and the media tool
     at max-w-3xl, which made one landing page's target twice the width of the
     other's for no reason a user could see. A drop target gains nothing from
     being wider than this. -->
<div class="mx-auto w-full max-w-3xl">
  <!-- A real button, so the visible text is the accessible name (WCAG 2.5.3) and
       Enter/Space come from the platform. The error lives outside it: `button` has
       children-presentational semantics, so anything nested here is hidden from
       screen readers, and this is the only feedback a failed open gets. -->
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
    <span class="text-lg font-medium text-neutral-800">{prompt}</span>
    <span class="text-sm text-neutral-600">
      or <span class="pp-click">click</span><span class="pp-tap">tap</span> to choose a file · nothing
      leaves your browser
    </span>
  </button>
  {#if error}
    <p class="mt-3 text-center text-sm text-red-600" role="alert">
      Could not open that file: {error}
    </p>
  {/if}
  <input
    bind:this={fileInput}
    type="file"
    {accept}
    class="sr-only"
    onchange={onInputChange}
    aria-label={inputLabel}
  />
</div>
