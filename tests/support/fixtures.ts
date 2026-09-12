/**
 * On-disk fixtures the end-to-end tests upload.
 *
 * The photo is the file the hub card is built from, so a test that drops it in
 * measures the picture the site advertises. A synthetic flat fill makes "the
 * output got smaller" mean something quite different from what it means for a
 * photograph.
 */
import { fileURLToPath } from 'node:url';

export const SAMPLE_PHOTO = fileURLToPath(
  new URL('../../src/assets/samples/sample-photo.jpg', import.meta.url)
);

export const SECRETS_PDF = fileURLToPath(
  new URL('../../src/lib/pdf/__fixtures__/text-secrets.pdf', import.meta.url)
);
