// Trim the padded brand logo (src/assets/blak-strip-logo.png) into a tight
// src/assets/logo.png for the site header. It lands in src/assets, not public,
// so astro:assets resizes and re-encodes it: the header renders it at 96px and
// the source is 791px wide. Favicons and PWA icons ship pre-made in public/
// (generated once from the brand kit), so this script only crops the wordmark.
// Run: pnpm gen:icons
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = await readFile(`${root}src/assets/blak-strip-logo.png`);

// trim() removes the surrounding matte so the header can size by height alone.
const logo = await sharp(src).trim().png().toBuffer();
await writeFile(`${root}src/assets/logo.png`, logo);
console.log('wrote src/assets/logo.png');
