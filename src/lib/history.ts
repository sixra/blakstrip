/**
 * Undo/redo over immutable snapshots.
 *
 * This lives in `src/lib` rather than inside the component on purpose: the rule
 * that a fresh commit discards the redo future is the kind of thing that breaks
 * quietly, and a stale future could reinstate a set of rectangles the user
 * deleted, i.e. hand back a document they believe is covered. Here it is under
 * the engine's coverage gate instead of resting on someone clicking Undo.
 *
 * Every operation returns a new value, so a component can hold one of these in
 * `$state` and reassign it.
 */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** Record a new present. Anything that was undone is no longer reachable. */
export function commit<T>(history: History<T>, next: T): History<T> {
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

export const canUndo = (history: History<unknown>): boolean => history.past.length > 0;
export const canRedo = (history: History<unknown>): boolean => history.future.length > 0;
