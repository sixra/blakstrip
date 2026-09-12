// Print one version's changelog section, for the release workflow to hand to
// `gh release create --notes-file -`.
// Run: node scripts/release-notes.mjs 2.1.0
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { notesFor } from './changelog.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = process.argv[2]?.replace(/^v/, '');

if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>');
  process.exit(1);
}

try {
  process.stdout.write(`${notesFor(await readFile(`${root}CHANGELOG.md`, 'utf8'), version)}\n`);
} catch (error) {
  // Exits non-zero so the workflow stops here rather than publishing a release
  // with an empty body, which reads as though the version changed nothing.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
