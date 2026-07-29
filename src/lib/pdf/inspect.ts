/**
 * Structural inspection shared by audit-on-load and verify-on-export. Reads
 * DocInfo and enumerates ACTUAL indirect objects (not references) so it sees
 * content regardless of whether a reference still points at it.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
  type PDFObject,
} from 'pdf-lib';
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

/** True when the stream is JPEG-compressed (`/Filter /DCTDecode`, name or array). */
function usesDct(dict: PDFDict): boolean {
  const filter = dict.get(PDFName.of('Filter'));
  const dct = PDFName.of('DCTDecode');
  if (filter === dct) return true;
  return filter instanceof PDFArray && filter.asArray().some((f) => f === dct);
}

/**
 * Scan JPEG bytes for an APP1 EXIF segment (`FF E1 … "Exif\0\0"`), which can
 * carry GPS coordinates and camera identifiers. The marker sits in the file
 * header, so bound the scan to the first 64 KiB.
 */
function hasExifSegment(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 7, 65536);
  for (let i = 0; i < limit; i += 1) {
    if (
      bytes[i] === 0xff &&
      bytes[i + 1] === 0xe1 &&
      bytes[i + 4] === 0x45 && // E
      bytes[i + 5] === 0x78 && // x
      bytes[i + 6] === 0x69 && // i
      bytes[i + 7] === 0x66 // f
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Enumerate the structural leak vectors in a PDF: document metadata, XMP,
 * annotations (incl. form-field widgets), embedded files, and JavaScript.
 */
export async function inspectStructure(bytes: Uint8Array): Promise<Finding[]> {
  // updateMetadata:false, otherwise pdf-lib stamps its own Producer at load
  // time and we'd report our own inspection as a finding. ignoreEncryption so a
  // protected PDF is detected rather than throwing (pdf-lib can't decrypt).
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });

  // An encrypted document's strings/streams are ciphertext to pdf-lib, so listing
  // its metadata would be garbage. Report the protection itself and stop.
  if (doc.isEncrypted) {
    return [
      {
        id: 'encrypted',
        severity: 'high',
        category: 'structure',
        title: 'Password or permission protected',
        detail:
          'This PDF is encrypted, so its hidden data cannot be listed. Remove the protection before redacting.',
      },
    ];
  }

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

  // Timestamps live in the Info dict alongside the strings above; a leftover one
  // discloses when (and in which time zone) the file was made or last edited.
  // stripDocInfo deletes these on export, so reporting them keeps audit and
  // verify symmetric: a date the audit flags is a date the output no longer has.
  const dates: Record<string, Date | undefined> = {
    Created: doc.getCreationDate(),
    Modified: doc.getModificationDate(),
  };
  for (const [key, value] of Object.entries(dates)) {
    if (value) {
      findings.push({
        id: `date-${key}`,
        severity: 'medium',
        category: 'metadata',
        title: `${key} date`,
        detail: value.toISOString(),
      });
    }
  }

  let annots = 0;
  let files = 0;
  let xmp = 0;
  let js = 0;
  let exif = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = dictOf(obj);
    if (!dict) continue;
    if (nameEq(dict, 'Type', 'Annot')) annots += 1;
    else if (nameEq(dict, 'Type', 'EmbeddedFile')) files += 1;
    else if (nameEq(dict, 'Type', 'Metadata')) xmp += 1;
    if (nameEq(dict, 'S', 'JavaScript') || dict.get(PDFName.of('JS')) !== undefined) js += 1;
    if (obj instanceof PDFRawStream && usesDct(dict) && hasExifSegment(obj.contents)) exif += 1;
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
      detail: `${annots} annotation object(s); comments or form values persist under any visual covering.`,
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
  if (exif > 0)
    findings.push({
      id: 'exif',
      severity: 'high',
      category: 'metadata',
      title: 'Photo (EXIF/GPS) data in an image',
      detail: `${exif} embedded JPEG(s) carry EXIF metadata, which can include GPS location and camera details. This sits inside the image itself, so redacting elsewhere on the page does not remove it.`,
    });

  // Page-piece data isn't typed, so enumeration can't spot it; check the
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

  // Optional-content groups (layers). A layer hidden by default is still in the
  // file and can be extracted or switched back on; pdf-lib also can't carry the
  // /OCProperties visibility config into the output, so we can't clean it;
  // surface it (and, via verify, withhold the clean verdict) instead.
  if (doc.catalog.get(PDFName.of('OCProperties')) !== undefined)
    findings.push({
      id: 'ocg',
      severity: 'medium',
      category: 'structure',
      title: 'Optional content layers',
      detail:
        'This document uses layers (optional content). A layer hidden by default can still be extracted or turned back on, so content you cannot see may remain in the file.',
    });

  return findings;
}
