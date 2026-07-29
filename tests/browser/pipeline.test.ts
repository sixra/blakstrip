import { describe, expect, it, vi } from 'vitest';
import { downloadBytes, exportRedactedPdf, redactedFileName } from '../../src/lib/pdf/export';
import { buildRedactedPdf } from '../../src/lib/pdf/redact';
import { loadPdf } from '../../src/lib/pdf/render';
import {
  collectRedactedText,
  extractAllText,
  searchDocumentRects,
} from '../../src/lib/pdf/textlayer';
import type { RedactionRect } from '../../src/lib/pdf/types';
import { verifyExport } from '../../src/lib/pdf/verify';
import {
  makeAnnotatedPdf,
  makeEncryptedLikePdf,
  makeRepeatedRunPdf,
  makeTextPdf,
} from '../support/testpdf';

const wholePage1: RedactionRect = { page: 1, x: 0, y: 0, w: 1, h: 1 };

describe('redact + export + verify', () => {
  it('rasterizes redacted pages and copies untouched pages', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    // Two rects on the same page exercises the group-by-page accumulation.
    const out = await buildRedactedPdf(pristine, doc, [
      { page: 1, x: 0.1, y: 0.1, w: 0.4, h: 0.05 },
      { page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.05 },
    ]);
    expect(out.getPageCount()).toBe(2);
  });

  it('refuses to build from a password/permission protected PDF', async () => {
    const pristine = await makeEncryptedLikePdf();
    const doc = await loadPdf(await makeTextPdf());
    await expect(buildRedactedPdf(pristine, doc, [])).rejects.toThrow(/protected/i);
  });

  it('makes redacted text unrecoverable while preserving untouched pages', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    const bytes = await exportRedactedPdf(pristine, doc, [wholePage1]);
    const out = await loadPdf(bytes.slice().buffer);
    const text = await extractAllText(out);
    expect(text).not.toContain('123-45-6789');
    expect(text).toContain('Jane Author'); // page 2 footer stays selectable
  });

  it('verify is clean for a normal export and flags terms that truly remain', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    const bytes = await exportRedactedPdf(pristine, doc, [wholePage1]);

    const ok = await verifyExport(bytes, ['123-45-6789']);
    expect(ok.clean).toBe(true);
    expect(ok.remaining).toEqual([]);
    expect(ok.leakedTerms).toEqual([]);

    const leak = await verifyExport(bytes, ['Jane Author']);
    expect(leak.leakedTerms).toEqual(['Jane Author']);
    expect(leak.clean).toBe(false);
  });

  it('verify flags a redacted run still present on an un-redacted page', async () => {
    const pristine = await makeRepeatedRunPdf();
    const doc = await loadPdf(pristine);
    // Redact page 1 only; the identical line survives on page 2.
    const rects = [wholePage1];
    const bytes = await exportRedactedPdf(pristine, doc, rects);
    // The terms the UI would derive from the boxes, fed back into verify.
    const terms = await collectRedactedText(doc, rects);
    const report = await verifyExport(bytes, terms);
    expect(report.leakedTerms).toContain('SEALED CASE 12-34567');
    expect(report.clean).toBe(false);
  });

  it('removes annotation content on copied pages (leak regression)', async () => {
    const pristine = await makeAnnotatedPdf();
    const doc = await loadPdf(pristine);
    const bytes = await exportRedactedPdf(pristine, doc, [wholePage1]);
    const report = await verifyExport(bytes);
    expect(report.remaining).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it('flags a surviving term as a whole word, not an incidental substring', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    // Redact page 1; page 2 keeps "Appendix, footer for Jane Author".
    const bytes = await exportRedactedPdf(pristine, doc, [wholePage1]);

    // "Appendix" survives as a word → flagged.
    expect((await verifyExport(bytes, ['Appendix'])).leakedTerms).toEqual(['Appendix']);
    // "ppen" only appears inside "Appendix" → not a real leak, not flagged.
    const sub = await verifyExport(bytes, ['ppen']);
    expect(sub.leakedTerms).toEqual([]);
    expect(sub.clean).toBe(true);
  });

  it('runs the pixel-coverage backstop when given the source doc and rects', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    const rects = await searchDocumentRects(doc, 'SSN: 123-45-6789');
    const bytes = await exportRedactedPdf(pristine, doc, rects);

    const ok = await verifyExport(bytes, [], { doc, rects });
    expect(ok.uncoveredRegions).toEqual([]);
    expect(ok.clean).toBe(true);

    // A box shrunk to a sliver of its run leaks pixels and blocks a clean verdict.
    const shrunk = rects.map((r) => ({ ...r, y: r.y + r.h * 0.65, h: r.h * 0.35 }));
    const shrunkBytes = await exportRedactedPdf(pristine, doc, shrunk);
    const leak = await verifyExport(shrunkBytes, [], { doc, rects: shrunk });
    expect(leak.uncoveredRegions.length).toBeGreaterThan(0);
    expect(leak.clean).toBe(false);
  });

  it('names the redacted file', () => {
    expect(redactedFileName('report.pdf')).toBe('report-redacted.pdf');
    expect(redactedFileName('report')).toBe('report-redacted.pdf');
  });

  it('downloads bytes as a PDF blob and revokes the object URL', () => {
    const anchors: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag as 'a');
      if (tag === 'a') anchors.push(el as HTMLAnchorElement);
      return el;
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    let blob: Blob | undefined;
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((b: Blob | MediaSource) => {
        blob = b as Blob;
        return 'blob:mock-url';
      });
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    try {
      downloadBytes(new Uint8Array([37, 80, 68, 70]), 'report-redacted.pdf');
      expect(anchors).toHaveLength(1);
      expect(anchors[0].download).toBe('report-redacted.pdf');
      expect(anchors[0].getAttribute('href')).toBe('blob:mock-url');
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(blob?.type).toBe('application/pdf');
      expect(revokeUrl).toHaveBeenCalledWith('blob:mock-url'); // no leaked object URL
    } finally {
      createSpy.mockRestore();
      clickSpy.mockRestore();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });

  it('rejects a non-PDF / truncated file with an error', async () => {
    // The bytes a corrupt upload would carry; loadPdf must reject, not hang, so
    // openFile's catch can surface a visible error.
    await expect(loadPdf(new Uint8Array([1, 2, 3, 4]).buffer)).rejects.toThrow();
  });
});
