<script lang="ts">
  interface Props {
    /** Shown below the zone when the last attempt failed. */
    error: string;
    onFile: (file: File) => void;
    onReject: (reason: string) => void;
  }

  const { error, onFile, onReject }: Props = $props();

  let dragOver = $state(false);
  let fileInput = $state<HTMLInputElement>();

  function accept(file: File): void {
    // Some platforms hand over a PDF with an empty type, so fall back to the
    // extension. Anything else gets a visible reason rather than silence.
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      onReject(`${file.name} is not a PDF.`);
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
    if (file) accept(file);
  }
  function onInputChange(e: Event): void {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (file) accept(file);
  }
</script>

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
  <span class="text-lg font-medium text-neutral-800">Drop a PDF to redact</span>
  <span class="text-sm text-neutral-600">
    or <span class="pp-click">click</span><span class="pp-tap">tap</span> to choose a file · nothing leaves
    your browser
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
  accept="application/pdf"
  class="sr-only"
  onchange={onInputChange}
  aria-label="Choose a PDF file"
/>
