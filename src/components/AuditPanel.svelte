<script lang="ts">
  import type { AuditReport } from '@lib/pdf/types';
  import FindingsList from './FindingsList.svelte';

  interface Props {
    report: AuditReport;
  }

  const { report }: Props = $props();

  const panelClass = $derived(
    report.findings.length > 0 ? 'border-warning bg-warning-surface' : 'border-line bg-raised'
  );
</script>

<section class={`mb-4 rounded-xl border p-4 ${panelClass}`} aria-label="Document audit">
  <FindingsList
    findings={report.findings}
    heading={(count) => `This file is hiding ${count} thing${count === 1 ? '' : 's'}:`}
    emptyMessage="✓ No hidden metadata, annotations, attachments, or scripts found."
  />
  {#if report.hasTextLayer}
    <p class="text-muted mt-2 text-xs">
      Has a text layer. Redacted pages are rasterized on export; untouched pages keep selectable
      text.
    </p>
  {:else}
    <p class="text-warning mt-2 text-xs">
      Looks like a scanned document (no text layer). Draw boxes over regions; flattening removes
      them safely.
    </p>
  {/if}
</section>
