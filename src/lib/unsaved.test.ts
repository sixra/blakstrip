import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearUnsaved, hasUnsavedWork, markUnsaved, whenWorkCleared } from './unsaved';

// Module state, so each test starts from nothing.
beforeEach(() => {
  clearUnsaved('pdf');
  clearUnsaved('photo');
  clearUnsaved('other');
});

describe('unsaved work', () => {
  it('reports nothing on a page where no file is open', () => {
    expect(hasUnsavedWork()).toBe(false);
  });

  it('reports work once an owner marks it', () => {
    markUnsaved('pdf');
    expect(hasUnsavedWork()).toBe(true);
  });

  it('stays clear after an owner releases', () => {
    markUnsaved('pdf');
    clearUnsaved('pdf');
    expect(hasUnsavedWork()).toBe(false);
  });

  it('does not let one owner clear another owner’s work', () => {
    // The reason this is a set and not a boolean: one owner finishing must not
    // declare the page safe while another still holds work.
    markUnsaved('photo');
    markUnsaved('other');
    clearUnsaved('other');
    expect(hasUnsavedWork()).toBe(true);
    clearUnsaved('photo');
    expect(hasUnsavedWork()).toBe(false);
  });

  it('is idempotent in both directions', () => {
    markUnsaved('pdf');
    markUnsaved('pdf');
    clearUnsaved('pdf');
    expect(hasUnsavedWork()).toBe(false);
    // Clearing something never marked must not throw or go negative, which a
    // counter-based version would.
    clearUnsaved('never-marked');
    expect(hasUnsavedWork()).toBe(false);
  });
});

describe('waiting for work to clear', () => {
  it('runs right away when nothing is held', () => {
    const callback = vi.fn();
    whenWorkCleared(callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('runs once, when the last owner clears', () => {
    const callback = vi.fn();
    markUnsaved('pdf');
    markUnsaved('photo');
    whenWorkCleared(callback);

    clearUnsaved('photo');
    expect(callback).not.toHaveBeenCalled();
    clearUnsaved('pdf');
    expect(callback).toHaveBeenCalledTimes(1);

    markUnsaved('pdf');
    clearUnsaved('pdf');
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
