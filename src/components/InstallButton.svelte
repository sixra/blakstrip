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

  let deferred = $state<InstallEvent | null>(null);
  let showIOS = $state(false);
  let iosHintOpen = $state(false);

  $effect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    const installed =
      window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    showIOS = isIOS && !installed;

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

  const btn = 'install-shimmer-text cursor-pointer text-sm font-semibold';
</script>

{#if deferred}
  <button class={btn} onclick={install} title="Install blakstrip to use it offline">
    Install app
  </button>
{:else if showIOS}
  <div class="relative">
    <button class={btn} aria-expanded={iosHintOpen} onclick={() => (iosHintOpen = !iosHintOpen)}>
      Install app
    </button>
    {#if iosHintOpen}
      <div
        role="note"
        class="absolute top-full right-0 z-20 mt-2 w-60 rounded-lg border border-neutral-200 bg-white p-3 text-left text-xs text-neutral-600 shadow-lg"
      >
        On iPhone or iPad, tap the Share button, then
        <strong class="font-semibold text-neutral-900">Add to Home Screen</strong>. blakstrip then
        opens like an app and works offline.
      </div>
    {/if}
  </div>
{/if}
