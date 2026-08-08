<script lang="ts">
  // Quiet PWA install affordance. On Chromium it appears only once the browser
  // fires `beforeinstallprompt` (the app is genuinely installable) and triggers
  // the native prompt. iOS Safari has no such event, so we offer a short "Add to
  // Home Screen" hint instead. Renders nothing when already installed or when
  // installation is not on offer, so it never nags.
  interface InstallEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  }

  // One-shot facts with no reactive inputs, so they belong at init rather than in
  // an effect. The island is client:only, so navigator is available here.
  const nav = navigator as Navigator & { standalone?: boolean };
  const alreadyInstalled =
    window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  let deferred = $state<InstallEvent | null>(null);
  let showIOS = $state(isIOS && !alreadyInstalled);
  let iosHintOpen = $state(false);

  $effect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      deferred = e as InstallEvent;
    };
    const onInstalled = () => {
      deferred = null;
      showIOS = false;
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  });

  async function install() {
    const e = deferred;
    if (!e) return;
    await e.prompt();
    await e.userChoice;
    deferred = null;
  }

  let containerEl = $state<HTMLDivElement>();
  // Let the iOS hint popover be dismissed the ways users expect: Escape and a
  // click anywhere outside it.
  $effect(() => {
    if (!iosHintOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') iosHintOpen = false;
    };
    const onClick = (e: MouseEvent) => {
      if (containerEl && !containerEl.contains(e.target as Node)) iosHintOpen = false;
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  });

  const btn = 'install-shimmer-text cursor-pointer text-sm font-semibold';
</script>

{#if deferred}
  <button class={btn} onclick={install} title="Install blakstrip to use it offline">
    Install app
  </button>
{:else if showIOS}
  <div class="relative" bind:this={containerEl}>
    <button
      class={btn}
      aria-expanded={iosHintOpen}
      aria-controls="ios-install-hint"
      onclick={() => (iosHintOpen = !iosHintOpen)}
    >
      Install app
    </button>
    {#if iosHintOpen}
      <div
        id="ios-install-hint"
        role="note"
        class="border-line bg-raised text-muted absolute top-full right-0 z-20 mt-2 w-60 rounded-lg border p-3 text-left text-xs shadow-lg"
      >
        On iPhone or iPad, tap the Share button, then
        <strong class="text-ink font-semibold">Add to Home Screen</strong>. blakstrip then opens
        like an app and works offline.
      </div>
    {/if}
  </div>
{/if}
