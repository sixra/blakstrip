<script lang="ts">
  import type { AuditReport, FindingSeverity } from '@lib/pdf/types';

  interface Props {
    report: AuditReport;
  }

  const { report }: Props = $props();

  // FindingSeverity is 'high' | 'medium', so there is no third case to style.
  const sevClass = (s: FindingSeverity): string => (s === 'high' ? 'bg-red-500' : 'bg-amber-500');
  const panelClass = $derived(
    report.findings.length > 0 ? 'border-amber-300 bg-amber-50' : 'border-neutral-200 bg-white'
  );
</script>

<section class={`mb-4 rounded-xl border p-4 ${panelClass}`} aria-label="Document audit">
  {#if report.findings.length > 0}
    <h2 class="text-sm font-semibold text-amber-800">
      This file is hiding {report.findings.length} thing{report.findings.length === 1 ? '' : 's'}:
    </h2>
    <ul class="mt-2 space-y-1">
      {#each report.findings as f (f.id)}
        <li class="flex items-start gap-2 text-sm text-neutral-700">
          <!-- The dot carries severity visually; the sr-only text carries it otherwise. -->
          <span
            class={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sevClass(f.severity)}`}
            aria-hidden="true"
          ></span>
          <span
            ><span class="sr-only"
              >{f.severity === 'high' ? 'High' : 'Medium'} severity:
            </span><span class="font-medium text-neutral-900">{f.title}:</span>
            {f.detail}</span
          >
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-sm text-neutral-600">
      ✓ No hidden metadata, annotations, attachments, or scripts found.
    </p>
  {/if}
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
