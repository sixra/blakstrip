/**
 * Saving bytes to disk, shared by every engine. Kept in its own module so it can
 * be imported without pulling an engine's writer along: pdf-lib and the codec
 * wasm are both large, and nothing can be downloaded until one of them has
 * already run and produced bytes.
 */

/**
 * Trigger a browser download with no network involved. The MIME type is passed
 * in rather than assumed: the same bytes are a PDF, a JPEG or an MP4 depending
 * on which engine produced them, and a wrong type here makes the OS open the
 * file with the wrong application.
 */
export function downloadBytes(bytes: Uint8Array, filename: string, mimeType: string): void {
  // Uint8Array is a valid BlobPart at runtime; TS 6's generic ArrayBufferLike
  // doesn't narrow to ArrayBuffer, so assert the part type.
  const blob = new Blob([bytes as BlobPart], { type: mimeType });
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

/** Insert a suffix before a filename's extension, e.g. photo.jpg -> photo-clean.jpg */
export function suffixFileName(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.');
  // No dot, or a leading dot with no extension (".gitignore"): append instead of
  // splitting, so the whole name is preserved rather than treated as a suffix.
  if (dot <= 0) return `${name}${suffix}`;
  return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
}
