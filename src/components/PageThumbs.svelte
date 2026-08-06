<script lang="ts">
  interface Props {
    thumbs: { page: number; url: string }[];
    currentPage: number;
    onSelect: (page: number) => void;
  }

  const { thumbs, currentPage, onSelect }: Props = $props();
</script>

<!-- A sidebar on a wide screen, a horizontal strip on a narrow one: at 320px a
     130px rail would leave the page itself too narrow to draw on. -->
<nav
  class="flex max-h-32 gap-2 overflow-x-auto pr-1 sm:block sm:max-h-[76vh] sm:gap-0 sm:overflow-x-visible sm:overflow-y-auto"
  aria-label="Pages"
>
  {#each thumbs as t (t.page)}
    <button
      class="block w-20 shrink-0 overflow-hidden rounded border bg-neutral-100 transition sm:mb-2 sm:w-full"
      class:border-neutral-900={t.page === currentPage}
      class:border-transparent={t.page !== currentPage}
      onclick={() => onSelect(t.page)}
      aria-current={t.page === currentPage ? 'page' : undefined}
    >
      <img src={t.url} alt={`Page ${t.page}`} class="block w-full" />
      <span class="block py-1 text-center text-xs text-neutral-600">{t.page}</span>
    </button>
  {/each}
</nav>
