<script lang="ts">
  import type { Finding, FindingSeverity } from '@lib/types';

  interface Props {
    findings: Finding[];
    /** Heading text when there is something to show. Receives the count. */
    heading: (count: number) => string;
    /** Shown instead of the list when nothing was found. */
    emptyMessage: string;
  }

  const { findings, heading, emptyMessage }: Props = $props();

  // FindingSeverity is 'high' | 'medium', so there is no third case to style.
  const sevClass = (s: FindingSeverity): string => (s === 'high' ? 'bg-red-500' : 'bg-amber-500');
</script>

{#if findings.length > 0}
  <h2 class="text-sm font-semibold text-amber-800">{heading(findings.length)}</h2>
  <ul class="mt-2 space-y-1">
    {#each findings as f (f.id)}
      <li class="flex items-start gap-2 text-sm text-neutral-700">
        <!-- The dot carries severity visually; the sr-only text carries it otherwise. -->
        <span
          class={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sevClass(f.severity)}`}
          aria-hidden="true"
        ></span>
        <span
          ><span class="sr-only">{f.severity === 'high' ? 'High' : 'Medium'} severity: </span><span
            class="font-medium text-neutral-900">{f.title}:</span
          >
          {f.detail}</span
        >
      </li>
    {/each}
  </ul>
{:else}
  <p class="text-sm text-neutral-600">{emptyMessage}</p>
{/if}
