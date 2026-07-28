// In-browser PDF fixtures for engine tests (pdf-lib runs in the browser).
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Two-page text PDF: page 1 has an SSN, "Jane Author" appears on both pages. */
export async function makeTextPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.setAuthor('Jane Author');
  doc.setTitle('Quarterly Report');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  const lines = ['Employee: Jane Author', 'SSN: 123-45-6789', 'Email: jane.author@example.com'];
  let y = 720;
  for (const line of lines) {
    p1.drawText(line, { x: 64, y, size: 14, font });
    y -= 26;
  }
  const p2 = doc.addPage([612, 792]);
  p2.drawText('Appendix — footer for Jane Author', { x: 64, y: 700, size: 14, font });
  return toArrayBuffer(await doc.save());
}

/** Two-page PDF whose page 2 carries an annotation with a secret in /Contents. */
export async function makeAnnotatedPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText('Page 1 — SSN: 123-45-6789', { x: 64, y: 700, size: 14, font });
  const p2 = doc.addPage([612, 792]);
  p2.drawText('Page 2 — Appendix', { x: 64, y: 700, size: 14, font });
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'FreeText',
    Rect: [64, 600, 460, 620],
    Contents: PDFString.of('ANNOTATION_SECRET_7Q'),
  });
  p2.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
  return toArrayBuffer(await doc.save());
}

/**
 * One page where the word "CONFIDENTIAL" is drawn as two adjacent runs in
 * different fonts, so pdf.js emits it as two text items — exercising search that
 * must span runs.
 */
export async function makeSplitRunPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const courier = await doc.embedFont(StandardFonts.Courier);
  const page = doc.addPage([612, 792]);
  const size = 14;
  const head = 'CONF';
  page.drawText(head, { x: 64, y: 700, size, font: helv });
  const w = helv.widthOfTextAtSize(head, size);
  page.drawText('IDENTIAL', { x: 64 + w, y: 700, size, font: courier });
  return toArrayBuffer(await doc.save());
}

/**
 * Two pages sharing the identical run "SEALED CASE 12-34567", so redacting only
 * page 1 leaves the same text recoverable on page 2.
 */
export async function makeRepeatedRunPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const line = 'SEALED CASE 12-34567';
  const p1 = doc.addPage([612, 792]);
  p1.drawText(line, { x: 64, y: 700, size: 14, font });
  const p2 = doc.addPage([612, 792]);
  p2.drawText(line, { x: 64, y: 700, size: 14, font });
  return toArrayBuffer(await doc.save());
}

/**
 * One page with two single-run lines that mix character widths, to exercise
 * measured (not averaged) match geometry: "10827 Berlin." and "621412".
 */
export async function makeMixedRunPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('10827 Berlin.', { x: 64, y: 700, size: 18, font });
  page.drawText('621412', { x: 64, y: 660, size: 18, font });
  return toArrayBuffer(await doc.save());
}

/** Single-page PDF with graphics but no text — looks like a scan. */
export async function makeScanLikePdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.drawRectangle({ x: 20, y: 20, width: 260, height: 260 });
  return toArrayBuffer(await doc.save());
}
