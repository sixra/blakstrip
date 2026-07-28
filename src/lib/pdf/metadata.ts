/**
 * Strip everything that survives a visual black box: document metadata, the XMP
 * packet, annotations/comments, form fields, embedded JavaScript, and file
 * attachments. pdf-lib has built-ins only for DocInfo; the rest are low-level
 * catalog/page deletes.
 *
 * Note: form fields are **removed**, not flattened — flattening would paint the
 * field value permanently onto the page, the opposite of redaction.
 */
import type { PDFDocument } from 'pdf-lib';
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFObject } from 'pdf-lib';

/** Blank the DocInfo dictionary (author, title, keywords, producer, dates, …). */
export function stripDocInfo(doc: PDFDocument): void {
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setProducer('');
  doc.setCreator('');
  // The setters above have no equivalent for dates, and pdf-lib stamps both at
  // document creation — a leftover timestamp discloses when (and in which time
  // zone) the file was redacted. Delete them straight off the Info dict, which
  // the setters just guaranteed exists.
  const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
  info.delete(PDFName.of('CreationDate'));
  info.delete(PDFName.of('ModDate'));
  info.delete(PDFName.of('Trapped'));
}

/** Remove the XMP metadata stream (pdf-lib has no XMP API). */
export function stripXmp(doc: PDFDocument): void {
  doc.catalog.delete(PDFName.of('Metadata'));
}

/** Remove all annotations (comments, links, widgets) and the AcroForm. */
export function stripAnnotationsAndForms(doc: PDFDocument): void {
  doc.catalog.delete(PDFName.of('AcroForm'));
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of('Annots'));
  }
}

/** Remove document-level JavaScript and auto-run actions. */
export function stripJavaScript(doc: PDFDocument): void {
  doc.catalog.delete(PDFName.of('OpenAction'));
  doc.catalog.delete(PDFName.of('AA'));
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  names?.delete(PDFName.of('JavaScript'));
}

/** Remove embedded file attachments (both the name tree and /AF references). */
export function stripAttachments(doc: PDFDocument): void {
  doc.catalog.delete(PDFName.of('AF')); // associated-files array points at filespecs directly
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  names?.delete(PDFName.of('EmbeddedFiles'));
}

/**
 * Strip carriers that live on the catalog or individual pages, which the
 * catalog-scoped passes above miss: per-page XMP (`/Metadata`), page additional
 * actions (`/AA`), and authoring-app page-piece data (`/PieceInfo`, where
 * Illustrator/InDesign/Acrobat stash editable copies of the original content).
 */
export function stripPageExtras(doc: PDFDocument): void {
  doc.catalog.delete(PDFName.of('PieceInfo'));
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of('Metadata'));
    page.node.delete(PDFName.of('AA'));
    page.node.delete(PDFName.of('PieceInfo'));
  }
}

/**
 * Remove XMP metadata attached to embedded streams — image and form XObjects on
 * copied pages can carry their own `/Metadata` (camera info, authoring history).
 * `/Metadata` on a stream is always informational XMP, never functional, so it
 * is safe to drop from any stream; GC then reclaims the orphaned packet.
 *
 * Note: EXIF/GPS baked into the *bytes* of an embedded JPEG is not touched here
 * — that lives inside the compressed image data and would require re-encoding.
 */
export function stripEmbeddedMetadata(doc: PDFDocument): void {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) obj.dict.delete(PDFName.of('Metadata'));
  }
}

/** Collect every indirect reference held directly inside an object. */
function refsWithin(obj: PDFObject, acc: PDFRef[]): void {
  if (obj instanceof PDFRef) acc.push(obj);
  else if (obj instanceof PDFArray) for (const el of obj.asArray()) refsWithin(el, acc);
  else if (obj instanceof PDFStream) refsWithin(obj.dict, acc);
  else if (obj instanceof PDFDict) for (const [, v] of obj.entries()) refsWithin(v, acc);
}

/**
 * Remove every object not reachable from the trailer root. This is the crucial
 * pass: pdf-lib writes ALL objects in its context, not just referenced ones, so
 * deleting a `/Annots` (or `/EmbeddedFiles`, `/Metadata`, …) reference alone
 * leaves the orphaned content — annotation dicts, appearance streams,
 * attachments — sitting in the output. GC deletes anything now unreferenced.
 */
export function garbageCollect(doc: PDFDocument): void {
  const ctx = doc.context;
  const key = (r: PDFRef): string => `${r.objectNumber} ${r.generationNumber}`;
  const reachable = new Set<string>();
  const stack: PDFRef[] = [];
  for (const seed of [ctx.trailerInfo.Root, ctx.trailerInfo.Info]) {
    if (seed instanceof PDFRef) stack.push(seed);
  }
  // Fail safe: if we can't find the root, keep everything rather than wipe the doc.
  /* v8 ignore next -- defensive: a valid PDF trailer always has a Root */
  if (stack.length === 0) return;
  while (stack.length > 0) {
    const ref = stack.pop() as PDFRef;
    if (reachable.has(key(ref))) continue;
    reachable.add(key(ref));
    const obj = ctx.lookup(ref);
    /* v8 ignore next -- defensive: enumerated refs always resolve */
    if (!obj) continue;
    const found: PDFRef[] = [];
    refsWithin(obj, found);
    for (const r of found) if (!reachable.has(key(r))) stack.push(r);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(key(ref))) ctx.delete(ref);
  }
}

/** Apply every strip pass. Call right before saving the output document. */
export function stripAll(doc: PDFDocument): void {
  stripDocInfo(doc);
  stripXmp(doc);
  stripAnnotationsAndForms(doc);
  stripJavaScript(doc);
  stripAttachments(doc);
  stripPageExtras(doc);
  stripEmbeddedMetadata(doc);
  // Deleting references above only orphans the content; GC actually removes it.
  garbageCollect(doc);
}
