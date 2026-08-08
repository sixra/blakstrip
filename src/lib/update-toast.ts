/**
 * The "a new version is ready" notice, shown only when applying it immediately
 * would destroy something.
 *
 * Deliberately not a framework island. It has to exist on every page including
 * the hub, which otherwise ships no JavaScript at all, and it is a fixed panel
 * with two buttons: a component would cost more than it saves.
 *
 * Styling lives in `global.css` under `.sw-toast`, not in inline `style`
 * attributes, because the strict CSP hashes styles and blocks inline ones.
 */

const TOAST_ID = 'sw-update-toast';

/**
 * Show the notice, wiring `onReload` to the accept button.
 *
 * Announced politely rather than assertively, and it never takes focus. That is
 * the whole point of showing it instead of reloading: the visitor is mid-task,
 * possibly typing a search term, and interrupting them is the harm being
 * avoided. It stays until acted on, so finishing the current file and then
 * accepting works exactly as well as accepting straight away.
 */
export function showUpdateToast(onReload: () => void): void {
  // Guard against a second update arriving while the first notice is still up.
  if (document.getElementById(TOAST_ID)) return;

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.className = 'sw-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const message = document.createElement('p');
  message.className = 'sw-toast-message';
  message.textContent =
    'A new version of blakstrip is ready. Reloading will discard the file you have open.';

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'sw-toast-accept';
  reload.textContent = 'Reload';
  reload.addEventListener('click', onReload);

  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'sw-toast-dismiss';
  later.textContent = 'Later';
  later.addEventListener('click', () => toast.remove());

  const actions = document.createElement('div');
  actions.className = 'sw-toast-actions';
  actions.append(reload, later);

  toast.append(message, actions);
  document.body.append(toast);
}
