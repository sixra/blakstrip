<script lang="ts">
  import type { AuditReport } from '@lib/pdf/types';
  import FindingsList from './FindingsList.svelte';

  interface Props {
    report: AuditReport;
  }

  const { report }: Props = $props();

  const panelClass = $derived(
    report.findings.length > 0 ? 'border-amber-300 bg-amber-50' : 'border-neutral-200 bg-white'
  );
</script>

<section class={`mb-4 rounded-xl border p-4 ${panelClass}`} aria-label="Document audit">
  <FindingsList
    findings={report.findings}
    heading={(count) => `This file is hiding ${count} thing${count === 1 ? '' : 's'}:`}
    emptyMessage="✓ No hidden metadata, annotations, attachments, or scripts found."
  />
  {#if report.hasTextLayer}
    <p class="mt-2 text-xs text-neutral-600">
      Has a text layer. Redacted pages are rasterized on export; untouched pages keep selectable
      text.
    </p>
  {:else}
    <p class="mt-2 text-xs text-amber-700">
      Looks like a scanned document (no text layer). Draw boxes over regions; flattening removes
      them safely.
    </p>
  {/if}
</section>
