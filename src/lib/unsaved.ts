/**
 * Whether there is work in memory that a reload would destroy.
 *
 * This exists because of a decision made elsewhere: nothing in this app is
 * persisted, deliberately, since not storing your file is the guarantee the
 * product is built on. The cost is that a page reload is destructive in a way it
 * is not on an ordinary site. A user may have six redaction boxes drawn on a
 * document that exists nowhere else, or a compression running on a photo only
 * they have, and none of it survives a refresh.
 *
 * The service worker registration asks this before applying an update, so a
 * deploy landing mid-task offers a reload instead of performing one.
 *
 * Keyed by owner rather than a single boolean, so clearing is scoped: an island
 * can only retract its own mark. Exactly one island marks per page today, so the
 * key is not yet carrying weight; it is what stops a second one on a page from
 * declaring the first one's work safe to discard.
 */
const owners = new Set<string>();

/** Declare that `owner` holds work a reload would lose. Idempotent. */
export function markUnsaved(owner: string): void {
  owners.add(owner);
}

/** Declare that `owner` no longer holds anything. Idempotent. */
export function clearUnsaved(owner: string): void {
  owners.delete(owner);
}

/** True while any owner still holds work. */
export function hasUnsavedWork(): boolean {
  return owners.size > 0;
}
