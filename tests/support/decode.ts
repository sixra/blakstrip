/**
 * Decoding a fixture to raw pixels, shared by every format's tests.
 *
 * This is what turns "the strip did not touch the image data" from a claim into
 * a check: the bytes go through the browser's real decoder, and the output must
 * match the input pixel for pixel.
 */
export async function decodeToPixels(
  bytes: Uint8Array,
  mimeType: string
): Promise<Uint8ClampedArray> {
  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}
