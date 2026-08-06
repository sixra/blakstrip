// In-browser PDF fixtures for engine tests (pdf-lib runs in the browser).
import { degrees, PDFDocument, PDFName, PDFString, rgb, StandardFonts } from 'pdf-lib';

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
  p2.drawText('Appendix, footer for Jane Author', { x: 64, y: 700, size: 14, font });
  return toArrayBuffer(await doc.save());
}

/** Two-page PDF whose page 2 carries an annotation with a secret in /Contents. */
export async function makeAnnotatedPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText('Page 1, SSN: 123-45-6789', { x: 64, y: 700, size: 14, font });
  const p2 = doc.addPage([612, 792]);
  p2.drawText('Page 2, Appendix', { x: 64, y: 700, size: 14, font });
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
 * different fonts, so pdf.js emits it as two text items, exercising search that
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

/**
 * A PDF whose trailer carries an /Encrypt dictionary, so pdf-lib reports it as
 * encrypted. pdf-lib cannot produce real encryption, but its `isEncrypted` flag
 * keys off the trailer entry alone, which is exactly what our guards check.
 */
export async function makeEncryptedLikePdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const encrypt = doc.context.obj({ Filter: 'Standard', V: 1, R: 2 });
  doc.context.trailerInfo.Encrypt = doc.context.register(encrypt);
  return toArrayBuffer(await doc.save());
}

/**
 * A page carrying `/Rotate 90`, with a horizontal run drawn in user space that
 * therefore renders vertically. Exercises the viewport-transform geometry: the
 * search box must land over the on-screen glyphs, not in the unrotated quadrant.
 */
export async function makeRotatedPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.setRotation(degrees(90));
  page.drawText('ROTATEDSECRET', { x: 80, y: 700, size: 24, font });
  return toArrayBuffer(await doc.save());
}

/**
 * One page with a single large-font run whose glyphs carry deep descenders
 * ("gjpqy") and tall ascenders. Exercises font-relative vertical cover: a
 * page-absolute pad that suits body text leaves a 44pt glyph's tails exposed.
 */
export async function makeLargeGlyphPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('PgjyQ', { x: 64, y: 600, size: 44, font });
  return toArrayBuffer(await doc.save());
}

/**
 * A single page far wider than any canvas limit (10000×300 pt). Rendered at 2×
 * it would be 20000px across (past the max side), so it exercises the scale
 * clamp that keeps an oversized page from rasterizing blank.
 */
export async function makeWidePagePdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([10000, 300]);
  page.drawText('WIDE PAGE SECRET', { x: 80, y: 150, size: 48, font });
  return toArrayBuffer(await doc.save());
}

/**
 * Two pages where page 2 carries an optional-content group (a layer) in its
 * resources, plus the catalog's /OCProperties visibility config. Redacting only
 * page 1 leaves page 2 to be copied verbatim: the OCG travels with it while
 * /OCProperties, which lives on the catalog, does not. Exercises the gap where
 * verify used to certify such an export clean.
 */
export async function makeLayeredPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText('Page 1, SSN: 123-45-6789', { x: 64, y: 700, size: 14, font });
  const p2 = doc.addPage([612, 792]);
  p2.drawText('Page 2, visible text', { x: 64, y: 700, size: 14, font });

  const ocg = doc.context.register(
    doc.context.obj({ Type: 'OCG', Name: PDFString.of('Hidden Layer') })
  );
  // Referenced from page 2's resources so the copy carries it (and GC keeps it).
  p2.node.Resources()?.set(PDFName.of('Properties'), doc.context.obj({ MC0: ocg }));
  doc.catalog.set(
    PDFName.of('OCProperties'),
    doc.context.obj({ OCGs: [ocg], D: { OFF: [ocg], Order: [] } })
  );
  return toArrayBuffer(await doc.save());
}

/**
 * One page of light-grey text. Grey ink is still content (signatures, watermarks,
 * de-emphasised disclaimers), but it sits far above black on the luma scale, so it
 * is the case an ink threshold tuned to body text quietly stops checking.
 */
export async function makeGreyTextPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('GREYSECRET', { x: 64, y: 700, size: 28, font, color: rgb(0.6, 0.6, 0.6) });
  return toArrayBuffer(await doc.save());
}

/**
 * One page whose text is dense with regex metacharacters. Unescaped, such a term
 * is still a *syntactically valid* regex, it just stops matching the literal
 * text, so a term that genuinely survived is reported as not leaked.
 */
export async function makeMetacharPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Phone: +1 (555) 123-4567', { x: 64, y: 700, size: 14, font });
  return toArrayBuffer(await doc.save());
}

/**
 * One page, two lines, where the second begins with a word character. Without a
 * newline between them the extracted text reads "...Jane AuthorSensitive...", and
 * the \W word boundaries in verify stop seeing "Jane Author" as a whole token.
 * Single page on purpose: page joins insert their own newline and would mask it.
 */
export async function makeTwoLinePdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Reported by Jane Author', { x: 64, y: 700, size: 14, font });
  page.drawText('Sensitive, do not distribute', { x: 64, y: 674, size: 14, font });
  return toArrayBuffer(await doc.save());
}

/** Single-page PDF with graphics but no text, so it looks like a scan. */
export async function makeScanLikePdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.drawRectangle({ x: 20, y: 20, width: 260, height: 260 });
  return toArrayBuffer(await doc.save());
}
