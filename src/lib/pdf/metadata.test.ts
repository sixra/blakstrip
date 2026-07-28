import { inflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFName, PDFStream, PDFString, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { garbageCollect, stripAll } from './metadata';

/** Search raw bytes and every inflatable stream for a needle. */
function outputContains(bytes: Uint8Array, needle: string): boolean {
  const raw = Buffer.from(bytes).toString('latin1');
  if (raw.includes(needle)) return true;
  let idx = 0;
  for (;;) {
    const s = raw.indexOf('stream', idx);
    if (s === -1) break;
    const e = raw.indexOf('endstream', s);
    if (e === -1) break;
    const body = Buffer.from(raw.slice(s + 6, e), 'latin1');
    for (const off of [1, 2, 0]) {
      try {
        if (inflateSync(body.subarray(off)).toString('latin1').includes(needle)) return true;
      } catch {
        /* not a flate stream at this offset */
      }
    }
    idx = e + 9;
  }
  return false;
}

async function countAnnots(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const d = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (d && d.lookupMaybe(PDFName.of('Type'), PDFName) === PDFName.of('Annot')) n += 1;
  }
  return n;
}

describe('stripAll', () => {
  it('removes annotation content, including its appearance stream (the leak regression)', async () => {
    const CONTENTS = 'SECRET_ANNOT_CONTENTS';
    const AP = 'SECRET_APPEARANCE_STREAM';
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const ap = doc.context.flateStream(`BT /F1 12 Tf (${AP}) Tj ET`, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 250, 20],
    });
    const annot = doc.context.obj({
      Type: 'Annot',
      Subtype: 'FreeText',
      Rect: [50, 700, 300, 720],
      Contents: PDFString.of(CONTENTS),
      AP: { N: doc.context.register(ap) },
    });
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));

    // Sanity: the secrets are present before stripping.
    const before = await doc.save({ useObjectStreams: false });
    expect(outputContains(before, CONTENTS)).toBe(true);
    expect(outputContains(before, AP)).toBe(true);

    stripAll(doc);
    const after = await doc.save({ useObjectStreams: false });

    expect(await countAnnots(after)).toBe(0);
    expect(outputContains(after, CONTENTS)).toBe(false);
    expect(outputContains(after, AP)).toBe(false);
  });

  it('clears document metadata', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.setAuthor('Jane Author');
    doc.setTitle('Quarterly Report');
    stripAll(doc);
    const out = await PDFDocument.load(await doc.save(), { updateMetadata: false });
    expect(out.getAuthor() ?? '').toBe('');
    expect(out.getTitle() ?? '').toBe('');
  });

  it('removes embedded attachments and JavaScript from a loaded document', async () => {
    const seed = await PDFDocument.create();
    seed.addPage([612, 792]);
    await seed.attach(new Uint8Array([1, 2, 3, 4]), 'secret.bin');
    seed.addJavaScript('leak', 'app.alert("SECRET_JS")');
    // pdf-lib writes attachments/JS lazily at save; reload so they are real
    // objects (as in any PDF opened from disk), then strip.
    const doc = await PDFDocument.load(await seed.save());
    stripAll(doc);
    const after = await doc.save({ useObjectStreams: false });
    expect(outputContains(after, 'SECRET_JS')).toBe(false);
    expect(outputContains(after, 'secret.bin')).toBe(false);
  });

  it('removes page-level metadata and authoring-app page-piece data', async () => {
    const SECRET = 'PIECEINFO_EDITABLE_SECRET';
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const piece = doc.context.flateStream(`(${SECRET})`, { Type: 'Foo' });
    page.node.set(
      PDFName.of('PieceInfo'),
      doc.context.obj({ ADBE: { Private: doc.context.register(piece) } })
    );
    const pageXmp = doc.context.flateStream('<x:xmpmeta>PAGE_XMP</x:xmpmeta>', {
      Type: 'Metadata',
      Subtype: 'XML',
    });
    page.node.set(PDFName.of('Metadata'), doc.context.register(pageXmp));

    const before = await doc.save({ useObjectStreams: false });
    expect(outputContains(before, SECRET)).toBe(true);

    stripAll(doc);
    const after = await doc.save({ useObjectStreams: false });
    expect(outputContains(after, SECRET)).toBe(false);
    expect(outputContains(after, 'PAGE_XMP')).toBe(false);
  });

  it('strips XMP metadata embedded in an image/XObject stream', async () => {
    const SECRET = 'IMAGE_XMP_SECRET';
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const xmp = doc.context.flateStream(`<x:xmpmeta>${SECRET}</x:xmpmeta>`, {
      Type: 'Metadata',
      Subtype: 'XML',
    });
    const img = doc.context.flateStream('\x00\x01\x02', {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 1,
      Height: 1,
      Metadata: doc.context.register(xmp),
    });
    // Reference the image from the page so it is reachable (not GC'd for being an orphan).
    page.node.set(
      PDFName.of('Resources'),
      doc.context.obj({ XObject: { Im0: doc.context.register(img) } })
    );

    const before = await doc.save({ useObjectStreams: false });
    expect(outputContains(before, SECRET)).toBe(true);

    stripAll(doc);
    const after = await doc.save({ useObjectStreams: false });
    expect(outputContains(after, SECRET)).toBe(false);
  });

  it('keeps reachable page content, including objects shared across pages', async () => {
    const doc = await PDFDocument.create();
    // One font referenced by both pages — GC must visit the shared ref only once.
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([612, 792]);
    p1.drawText('hello', { x: 20, y: 20, size: 12, font });
    const p2 = doc.addPage([612, 792]);
    p2.drawText('world', { x: 20, y: 20, size: 12, font });
    stripAll(doc);
    const out = await PDFDocument.load(await doc.save());
    expect(out.getPageCount()).toBe(2);
  });

  it('garbageCollect tolerates a document with no trailer Info entry', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.context.trailerInfo.Info = undefined; // a PDF without a DocInfo dictionary
    garbageCollect(doc);
    const out = await PDFDocument.load(await doc.save());
    expect(out.getPageCount()).toBe(1);
  });

  it('garbageCollect visits a doubly-referenced object only once', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const shared = doc.context.register(doc.context.obj({ Marker: PDFName.of('X') }));
    // One holder references the same object via two keys (as filespecs do with /F & /UF).
    const holder = doc.context.obj({ A: shared, B: shared });
    doc.catalog.set(PDFName.of('Holder'), doc.context.register(holder));
    garbageCollect(doc);
    const out = await PDFDocument.load(await doc.save());
    expect(out.getPageCount()).toBe(1);
  });
});
