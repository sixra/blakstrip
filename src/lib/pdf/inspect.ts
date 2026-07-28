/**
 * Structural inspection shared by audit-on-load and verify-on-export. Reads
 * DocInfo and enumerates ACTUAL indirect objects (not references) so it sees
 * content regardless of whether a reference still points at it.
 */
import { PDFDict, PDFDocument, PDFName, PDFStream, type PDFObject } from 'pdf-lib';
import type { Finding } from './types';

function dictOf(obj: PDFObject): PDFDict | undefined {
  if (obj instanceof PDFStream) return obj.dict;
  if (obj instanceof PDFDict) return obj;
  return undefined;
}

/** True when `dict[key]` is the name `/value` (PDFName instances are interned). */
function nameEq(dict: PDFDict, key: string, value: string): boolean {
  return dict.lookupMaybe(PDFName.of(key), PDFName) === PDFName.of(value);
}

/**
 * Enumerate the structural leak vectors in a PDF: document metadata, XMP,
 * annotations (incl. form-field widgets), embedded files, and JavaScript.
 */
export async function inspectStructure(bytes: Uint8Array): Promise<Finding[]> {
  // updateMetadata:false — otherwise pdf-lib stamps its own Producer at load
  // time and we'd report our own inspection as a finding.
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const findings: Finding[] = [];

  const info: Record<string, string | undefined> = {
    Title: doc.getTitle(),
    Author: doc.getAuthor(),
    Subject: doc.getSubject(),
    Keywords: doc.getKeywords(),
    Producer: doc.getProducer(),
    Creator: doc.getCreator(),
  };
  for (const [key, value] of Object.entries(info)) {
    if (value && value.trim().length > 0) {
      findings.push({
        id: `meta-${key}`,
        severity: 'medium',
        category: 'metadata',
        title: `${key} metadata`,
        detail: value,
      });
    }
  }

  let annots = 0;
  let files = 0;
  let xmp = 0;
  let js = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = dictOf(obj);
    if (!dict) continue;
    if (nameEq(dict, 'Type', 'Annot')) annots += 1;
    else if (nameEq(dict, 'Type', 'EmbeddedFile')) files += 1;
    else if (nameEq(dict, 'Type', 'Metadata')) xmp += 1;
    if (nameEq(dict, 'S', 'JavaScript') || dict.get(PDFName.of('JS')) !== undefined) js += 1;
  }

  if (xmp > 0)
    findings.push({
      id: 'xmp',
      severity: 'medium',
      category: 'xmp',
      title: 'XMP metadata packet',
      detail: 'Embedded XMP metadata (may repeat author, tool, or history).',
    });
  if (annots > 0)
    findings.push({
      id: 'annots',
      severity: 'high',
      category: 'annotation',
      title: 'Annotations / form fields',
      detail: `${annots} annotation object(s) — comments or form values persist under any visual covering.`,
    });
  if (files > 0)
    findings.push({
      id: 'attachments',
      severity: 'high',
      category: 'attachment',
      title: 'Embedded file attachments',
      detail: `${files} embedded file(s).`,
    });
  if (js > 0)
    findings.push({
      id: 'javascript',
      severity: 'high',
      category: 'javascript',
      title: 'Embedded JavaScript',
      detail: `${js} script object(s).`,
    });

  // Page-piece data isn't typed, so enumeration can't spot it — check the
  // catalog and each page directly for a /PieceInfo entry.
  const hasPieceInfo =
    doc.catalog.get(PDFName.of('PieceInfo')) !== undefined ||
    doc.getPages().some((p) => p.node.get(PDFName.of('PieceInfo')) !== undefined);
  if (hasPieceInfo)
    findings.push({
      id: 'pieceinfo',
      severity: 'medium',
      category: 'structure',
      title: 'Application page-piece data',
      detail: 'Private editable content (/PieceInfo) left by an authoring app.',
    });

  return findings;
}
