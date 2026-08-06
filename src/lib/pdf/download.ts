/**
 * Saving bytes to disk. Deliberately separate from `export.ts`: that module pulls
 * in pdf-lib through the build and strip passes, and importing these two helpers
 * from it would drag the whole writer into the island's first chunk even though
 * nothing can be downloaded until a document has been opened and exported.
 */

/** Turn an input filename into its redacted counterpart. */
export function redactedFileName(name: string): string {
  return `${name.replace(/\.pdf$/i, '')}-redacted.pdf`;
}

/** Trigger a browser download of bytes with no network involved. */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
  // Uint8Array is a valid BlobPart at runtime; TS 6's generic ArrayBufferLike
  // doesn't narrow to ArrayBuffer, so assert the part type.
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safe to revoke synchronously: the blob is copied into the anchor's URL record
  // when href is assigned, so the download already holds its own reference.
  URL.revokeObjectURL(url);
}
