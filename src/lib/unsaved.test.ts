import { beforeEach, describe, expect, it } from 'vitest';
import { clearUnsaved, hasUnsavedWork, markUnsaved } from './unsaved';

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
    // The reason this is a set and not a boolean: the compression panel is
    // mounted inside the media tool, so two owners are live at once and the one
    // that finishes first would otherwise declare the page safe to reload.
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
