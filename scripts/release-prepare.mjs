// Cut a release: move [Unreleased] into a dated section, add its compare link,
// and set the version in package.json. Everything after this is the workflow's.
// Run: node scripts/release-prepare.mjs 2.2.0
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cutRelease } from './changelog.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = process.argv[2]?.replace(/^v/, '');

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/release-prepare.mjs <major.minor.patch>');
  process.exit(1);
}

const pkgPath = `${root}package.json`;
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
const changelogPath = `${root}CHANGELOG.md`;

// Today in the repository's own local time, matching the dates already in the
// file, rather than UTC, which would date an evening release tomorrow.
const date = new Date().toLocaleDateString('sv-SE');

try {
  const cut = cutRelease(
    await readFile(changelogPath, 'utf8'),
    version,
    date,
    pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
  );

  await writeFile(changelogPath, cut);
  // Rewritten rather than re-serialised: JSON.stringify would reorder nothing
  // but would reformat the whole file and fight prettier over the trailing line.
  await writeFile(
    pkgPath,
    (await readFile(pkgPath, 'utf8')).replace(/^(\s*"version":\s*)"[^"]+"/m, `$1"${version}"`)
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log(`CHANGELOG.md: cut [Unreleased] into [${version}] - ${date}`);
console.log(`package.json: version ${pkg.version} -> ${version}`);
console.log('\nWrite the summary paragraph under the new heading, then open a PR.');
