// Generate test PDFs for driving the UI and (later) unit tests.
// Run: pnpm gen:fixtures
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFString, rgb, StandardFonts } from 'pdf-lib';

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
