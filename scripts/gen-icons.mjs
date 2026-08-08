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
const trimmed = await sharp(src).trim().png().toBuffer();
await writeFile(`${root}src/assets/logo.png`, trimmed);
console.log('wrote src/assets/logo.png');

// The social card. Generated from the same wordmark rather than drawn by hand, so
// the brand cannot drift between the header and the link preview.
//
// The previous card was the wordmark centred on the canvas and nothing else: a
// person seeing it in a chat learned the name and not one thing about what it
// does. This one says what the tools remove, which is the only reason anyone
// clicks a link to a utility.
//
// Text is drawn through an SVG layer because sharp has no text primitive. The
// font stack resolves on the machine that runs the build, so it is a common
// sans-serif list rather than anything exotic, and the type is large enough that
// a fallback substitution still looks deliberate.
const OG = { width: 1200, height: 630 };
const CANVAS = '#f4f4f4';
const INK = '#0a0a0a';
const MUTED = '#525252';

const wordmark = await sharp(trimmed).resize({ width: 420 }).toBuffer({ resolveWithObject: true });

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// Positions derive from the wordmark's rendered height rather than being typed in.
// Guessed values put the first line of copy straight through the logo.
const MARGIN = 90;
const LOGO_TOP = 120;
const logoBottom = LOGO_TOP + wordmark.info.height;
const leadAt = logoBottom + 96;
const lines = [
  { text: 'Redact a PDF for good.', y: leadAt },
  { text: 'Strip a photo of where you were.', y: leadAt + 60 },
];

const overlay = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${OG.width}" height="${OG.height}">
     <style>
       .lead { font: 700 46px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; fill: ${INK}; }
       .foot { font: 400 28px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; fill: ${MUTED}; }
     </style>
     ${lines.map((l) => `<text x="${MARGIN}" y="${l.y}" class="lead">${escape(l.text)}</text>`).join('\n')}
     <text x="${MARGIN}" y="${leadAt + 138}" class="foot">${escape('In your browser. Nothing is uploaded.')}</text>
   </svg>`
);

const card = await sharp({
  create: { width: OG.width, height: OG.height, channels: 3, background: CANVAS },
})
  .composite([
    { input: wordmark.data, left: MARGIN, top: LOGO_TOP },
    { input: overlay, left: 0, top: 0 },
  ])
  .png()
  .toBuffer();

await writeFile(`${root}public/og-image.png`, card);
console.log(`wrote public/og-image.png (${card.length} bytes, ${OG.width}x${OG.height})`);
