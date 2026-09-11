// Generate test PDFs for driving the UI and (later) unit tests.
// Run: pnpm gen:fixtures
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFString, rgb, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = `${root}src/lib/pdf/__fixtures__`;
await mkdir(outDir, { recursive: true });

// A text PDF carrying a known secret + author metadata + a second page.
const doc = await PDFDocument.create();
doc.setTitle('Quarterly Report');
doc.setAuthor('Jane Author');
doc.setSubject('Confidential');
doc.setKeywords(['confidential', 'internal']);
doc.setCreator('blakstrip-fixture');
doc.setProducer('blakstrip-fixture');

const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

const lines1 = [
  'CONFIDENTIAL: Internal Distribution Only',
  '',
  'Employee: Jane Author',
  'SSN: 123-45-6789',
  'Email: jane.author@example.com',
  'Phone: +1 (555) 123-4567',
  '',
  'This document contains sensitive personal information that should',
  'be redacted before any external distribution.',
];

const p1 = doc.addPage([612, 792]);
let y = 720;
for (const line of lines1) {
  const f = line.startsWith('CONFIDENTIAL') ? bold : font;
  p1.drawText(line, { x: 64, y, size: 14, font: f, color: rgb(0, 0, 0) });
  y -= 26;
}

const p2 = doc.addPage([612, 792]);
p2.drawText('Appendix', { x: 64, y: 720, size: 18, font: bold });
p2.drawText('Repeated footer: Jane Author, do not distribute', {
  x: 64,
  y: 64,
  size: 10,
  font,
});
p1.drawText('Repeated footer: Jane Author, do not distribute', {
  x: 64,
  y: 40,
  size: 10,
  font,
});

const bytes = await doc.save();
await writeFile(`${outDir}/text-secrets.pdf`, bytes);
console.log(`wrote src/lib/pdf/__fixtures__/text-secrets.pdf (${bytes.length} bytes)`);

// A fixture whose page 2 carries an annotation with a secret in /Contents, a
// leak vector that must not survive export even though page 2 isn't redacted.
const annotated = await PDFDocument.create();
annotated.setAuthor('Jane Author');
const f2 = await annotated.embedFont(StandardFonts.Helvetica);
const ap1 = annotated.addPage([612, 792]);
ap1.drawText('Page 1, SSN: 123-45-6789', { x: 64, y: 700, size: 14, font: f2 });
const ap2 = annotated.addPage([612, 792]);
ap2.drawText('Page 2, Appendix (no visible secret)', { x: 64, y: 700, size: 14, font: f2 });
const noteAnnot = annotated.context.obj({
  Type: 'Annot',
  Subtype: 'FreeText',
  Rect: [64, 600, 460, 620],
  Contents: PDFString.of('ANNOTATION SECRET acct 999-88-7777'),
});
ap2.node.set(PDFName.of('Annots'), annotated.context.obj([annotated.context.register(noteAnnot)]));
const annBytes = await annotated.save();
await writeFile(`${outDir}/annotated.pdf`, annBytes);
console.log(`wrote src/lib/pdf/__fixtures__/annotated.pdf (${annBytes.length} bytes)`);

// A photo carrying the things a phone actually records, for the hub cards.
//
// The cards show real findings and real compressed sizes from the real engines,
// so it needs a real file to find them in. Written here rather than committed as
// an opaque blob so anyone can see exactly what was planted and check that the
// cards are not just a picture of some results.
//
// Textured rather than a flat fill, and encoded the way a camera would. A flat
// fill compresses to nothing, so every preset would report the same implausible
// saving; and at the quality the fill used to carry (82) the "best quality"
// preset re-encodes at 92 and comes out *larger*, which is a true number that
// tells the reader nothing about what this tool does for a photograph.
//
// Noise and background are mutually exclusive in sharp's `create`, so the colour
// arrives as a composited gradient rather than as a background.
//
// GPS lives in IFD3 and is written as rationals: 51°30'32.30"N, 0°07'43.66"W.
const gradient = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
     <defs>
       <linearGradient id="g" x1="0" y1="0" x2="0.3" y2="1">
         <stop offset="0" stop-color="#9ec5e8" />
         <stop offset="0.55" stop-color="#c7a46b" />
         <stop offset="1" stop-color="#243a2e" />
       </linearGradient>
     </defs>
     <rect width="1200" height="900" fill="url(#g)" />
   </svg>`
);

const photo = await sharp({
  create: {
    width: 1200,
    height: 900,
    channels: 3,
    noise: { type: 'gaussian', mean: 128, sigma: 40 },
  },
})
  // Blurring the noise is what sets the file size: grain at this scale is
  // incompressible, and un-blurred it lands near a megabyte.
  .blur(1.5)
  .composite([{ input: gradient, blend: 'soft-light' }])
  .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
  .withExif({
    IFD0: {
      Make: 'ACME',
      Model: 'Pixelbird 9',
      Software: 'Pixelbird Camera 4.2',
      Artist: 'Jane Author',
      Copyright: 'Jane Author',
      DateTime: '2024:06:11 14:02:37',
    },
    IFD3: {
      GPSLatitudeRef: 'N',
      GPSLatitude: '51/1 30/1 3230/100',
      GPSLongitudeRef: 'W',
      GPSLongitude: '0/1 7/1 4366/100',
    },
  })
  .toBuffer();

await mkdir(`${root}src/assets/samples`, { recursive: true });
await writeFile(`${root}src/assets/samples/sample-photo.jpg`, photo);
console.log(`wrote src/assets/samples/sample-photo.jpg (${photo.length} bytes)`);
