import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, commit, initHistory, redo, undo } from './history';

describe('history', () => {
  it('starts with nothing to undo or redo', () => {
    const h = initHistory<number[]>([]);
    expect(h.present).toEqual([]);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('walks back and forward through commits', () => {
    let h = initHistory<number[]>([]);
    h = commit(h, [1]);
    h = commit(h, [1, 2]);
    expect(h.present).toEqual([1, 2]);

    h = undo(h);
    expect(h.present).toEqual([1]);
    h = undo(h);
    expect(h.present).toEqual([]);
    expect(canUndo(h)).toBe(false);

    h = redo(h);
    expect(h.present).toEqual([1]);
    h = redo(h);
    expect(h.present).toEqual([1, 2]);
    expect(canRedo(h)).toBe(false);
  });

  it('drops the redo future once a new commit lands', () => {
    // The rule that matters: without it, redo could reinstate rectangles the
    // user deleted, and they would export believing that area is covered.
    let h = initHistory<number[]>([]);
    h = commit(h, [1]);
    h = commit(h, [1, 2]);
    h = undo(h); // future now holds [1, 2]
    h = commit(h, [9]); // a different edit from that point

    expect(canRedo(h)).toBe(false);
    expect(redo(h).present).toEqual([9]);
  });

  it('is a no-op at either end rather than throwing', () => {
    const empty = initHistory<number[]>([]);
    expect(undo(empty)).toBe(empty);
    expect(redo(empty)).toBe(empty);
  });

  it('never mutates the value it was given', () => {
    const h = initHistory<number[]>([]);
    const after = commit(h, [1]);
    expect(h).toEqual({ past: [], present: [], future: [] });
    expect(after).not.toBe(h);
  });
});
