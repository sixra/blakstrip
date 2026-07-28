import { PDFDocument, PDFName, PDFRawStream, PDFString, type PDFRef } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { inspectStructure } from './inspect';
import { stripAll } from './metadata';

/** A materialized (saved + reloaded) document carrying every leak vector. */
async function loadedDocWithEverything(): Promise<PDFDocument> {
  const seed = await PDFDocument.create();
  const page = seed.addPage([612, 792]);
  seed.setAuthor('Jane Author');
  await seed.attach(new Uint8Array([1, 2, 3]), 'secret.bin');
  seed.addJavaScript('x', 'app.alert(1)');
  const annot = seed.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [0, 0, 10, 10],
    Contents: PDFString.of('a private note'),
  });
  page.node.set(PDFName.of('Annots'), seed.context.obj([seed.context.register(annot)]));
  const xmp = seed.context.flateStream('<?xpacket?><x:xmpmeta/>', {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  seed.catalog.set(PDFName.of('Metadata'), seed.context.register(xmp));

  // Page-level carriers the catalog-scoped strips miss.
  const pageXmp = seed.context.flateStream('<?xpacket?><x:xmpmeta/>', {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  page.node.set(PDFName.of('Metadata'), seed.context.register(pageXmp));
  const jsAction = seed.context.obj({
    S: PDFName.of('JavaScript'),
    JS: PDFString.of('app.alert(2)'),
  });
  page.node.set(PDFName.of('AA'), seed.context.obj({ O: seed.context.register(jsAction) }));
  const piece = seed.context.obj({ ADBE: { Private: PDFString.of('editable original') } });
  page.node.set(PDFName.of('PieceInfo'), seed.context.register(piece));

  return PDFDocument.load(await seed.save(), { updateMetadata: false });
}

describe('inspectStructure', () => {
  it('detects metadata, XMP, annotations, attachments, and JavaScript', async () => {
    const findings = await inspectStructure(await (await loadedDocWithEverything()).save());
    const categories = new Set(findings.map((f) => f.category));
    expect(categories.has('metadata')).toBe(true);
    expect(categories.has('xmp')).toBe(true);
    expect(categories.has('annotation')).toBe(true);
    expect(categories.has('attachment')).toBe(true);
    expect(categories.has('javascript')).toBe(true);
    expect(categories.has('structure')).toBe(true); // /PieceInfo page-piece data
  });

  it('reports nothing once stripAll has run (audit ↔ strip consistency)', async () => {
    const doc = await loadedDocWithEverything();
    stripAll(doc);
    const findings = await inspectStructure(await doc.save());
    expect(findings).toEqual([]);
  });

  it('flags a protected PDF and skips structural listing', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.setAuthor('Should Not Be Listed');
    const encrypt = doc.context.obj({ Filter: 'Standard', V: 1, R: 2 });
    doc.context.trailerInfo.Encrypt = doc.context.register(encrypt);
    const findings = await inspectStructure(await doc.save());
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('encrypted');
    expect(findings[0].category).toBe('structure');
    expect(findings[0].severity).toBe('high');
  });

  it('flags EXIF/GPS data in DCTDecode images (name and array /Filter), ignoring clean JPEGs', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    // A JPEG header carrying an APP1 EXIF segment (FF E1 … "Exif\0\0").
    const withExif = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0, 0, 0, 0,
    ]);
    // A JPEG with no APP1 EXIF segment.
    const noExif = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x08, 1, 2, 3, 4, 5, 6]);
    const mk = (filter: string | string[], bytes: Uint8Array): PDFRef =>
      doc.context.register(
        PDFRawStream.of(
          doc.context.obj({
            Type: 'XObject',
            Subtype: 'Image',
            Width: 1,
            Height: 1,
            Filter: filter,
          }),
          bytes
        )
      );
    page.node.set(
      PDFName.of('Resources'),
      doc.context.obj({
        XObject: {
          Im0: mk('DCTDecode', withExif), // name /Filter
          Im1: mk(['DCTDecode'], withExif), // array /Filter
          Im2: mk('DCTDecode', noExif), // DCT but no EXIF — must not count
        },
      })
    );
    const findings = await inspectStructure(await doc.save());
    const exif = findings.find((f) => f.id === 'exif');
    expect(exif).toBeDefined();
    expect(exif?.category).toBe('metadata');
    expect(exif?.detail).toContain('2'); // only the two EXIF-bearing images
  });

  it('flags optional-content (OCG) layers via the catalog', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [], D: { Order: [] } }));
    const findings = await inspectStructure(await doc.save());
    expect(findings.some((f) => f.id === 'ocg')).toBe(true);
  });

  it('skips non-dictionary objects and flags a bare /JS action', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    // An indirect array (not a dict/stream) and a dict carrying a raw /JS entry.
    doc.context.register(doc.context.obj([1, 2, 3]));
    doc.context.register(doc.context.obj({ JS: PDFString.of('app.alert(1)') }));
    const findings = await inspectStructure(await doc.save());
    expect(findings.some((f) => f.category === 'javascript')).toBe(true);
  });
});
