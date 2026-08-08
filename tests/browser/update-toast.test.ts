/**
 * The update notice. Built with plain DOM rather than a component, so this is
 * where its behaviour is pinned.
 *
 * The parts that matter are not visual: it must not stack, it must not steal
 * focus from someone mid-task (the entire reason it exists instead of a reload),
 * and both buttons must do what they say.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showUpdateToast } from '../../src/lib/update-toast';

const toast = (): HTMLElement | null => document.getElementById('sw-update-toast');

afterEach(() => {
  toast()?.remove();
});

describe('the update toast', () => {
  it('offers a reload and says what it will cost', () => {
    showUpdateToast(() => {});

    const el = toast();
    expect(el).not.toBeNull();
    // A bare "new version available" would not tell someone with a document open
    // why they might want to wait.
    expect(el?.textContent).toContain('discard the file you have open');
    expect(el?.querySelector('.sw-toast-accept')?.textContent).toBe('Reload');
    expect(el?.querySelector('.sw-toast-dismiss')?.textContent).toBe('Later');
  });

  it('announces politely and does not take focus', () => {
    const before = document.activeElement;
    showUpdateToast(() => {});

    // Assertive would interrupt a screen reader mid-sentence, and moving focus
    // would yank the caret out of the redactor's search box. Both are the harm
    // this notice exists to avoid.
    expect(toast()?.getAttribute('role')).toBe('status');
    expect(toast()?.getAttribute('aria-live')).toBe('polite');
    expect(document.activeElement).toBe(before);
  });

  it('applies the update when Reload is pressed', () => {
    const onReload = vi.fn();
    showUpdateToast(onReload);

    toast()?.querySelector<HTMLButtonElement>('.sw-toast-accept')?.click();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('dismisses without applying when Later is pressed', () => {
    const onReload = vi.fn();
    showUpdateToast(onReload);

    toast()?.querySelector<HTMLButtonElement>('.sw-toast-dismiss')?.click();
    expect(toast()).toBeNull();
    expect(onReload).not.toHaveBeenCalled();
  });

  it('does not stack when a second update arrives', () => {
    // Two deploys while a long session is open would otherwise leave two notices
    // on top of each other, the lower one wired to a superseded worker.
    showUpdateToast(() => {});
    showUpdateToast(() => {});

    expect(document.querySelectorAll('#sw-update-toast')).toHaveLength(1);
  });
});
