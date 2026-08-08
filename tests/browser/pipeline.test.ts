import { describe, expect, it, vi } from 'vitest';
import { downloadBytes } from '../../src/lib/download';
import { redactedFileName } from '../../src/lib/pdf/download';
import { exportRedactedPdf } from '../../src/lib/pdf/export';
import { buildRedactedPdf } from '../../src/lib/pdf/redact';
import { loadPdf } from '../../src/lib/pdf/render';
import {
  collectRedactedText,
  extractAllText,
  extractPageText,
  searchDocumentRects,
} from '../../src/lib/pdf/textlayer';
import type { RedactionRect } from '../../src/lib/pdf/types';
import { verifyExport } from '../../src/lib/pdf/verify';
import {
  makeAnnotatedPdf,
  makeEncryptedLikePdf,
  makeLayeredPdf,
  makeMetacharPdf,
  makeRepeatedRunPdf,
  makeTextPdf,
  makeTwoLinePdf,
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

  it('names the pages where boxed text is still readable', async () => {
    const pristine = await makeRepeatedRunPdf();
    const doc = await loadPdf(pristine);
    // Redact page 1 only; the identical line survives on page 2.
    const rects = [wholePage1];
    const bytes = await exportRedactedPdf(pristine, doc, rects);
    // The text the UI derives from the boxes, fed back in as box-local terms.
    const boxText = await collectRedactedText(doc, rects);
    const report = await verifyExport(bytes, [], undefined, boxText);

    // Not a failed redaction, so it does not belong in leakedTerms, but it still
    // blocks a clean verdict and now says where to look.
    expect(report.leakedTerms).toEqual([]);
    expect(report.survivingElsewhere).toEqual([{ term: 'SEALED CASE 12-34567', pages: [2] }]);
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

  it('refuses a clean verdict when a copied page still carries a layer', async () => {
    const pristine = await makeLayeredPdf();
    const doc = await loadPdf(pristine);
    // Redact page 1 only, so page 2 is copied verbatim and brings its OCG along.
    const bytes = await exportRedactedPdf(pristine, doc, [wholePage1]);
    const report = await verifyExport(bytes);
    // The catalog's /OCProperties does not survive copyPages, so keying off it
    // alone would find nothing here and hand back "clean" on a file whose hidden
    // layer may now render visible.
    expect(report.remaining.some((f) => f.id === 'ocg')).toBe(true);
    expect(report.clean).toBe(false);
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

  it('matches a redacted term literally, not as a regular expression', async () => {
    const pristine = await makeMetacharPdf();
    const doc = await loadPdf(pristine);
    // No redactions, so the line genuinely survives in the output.
    const bytes = await exportRedactedPdf(pristine, doc, []);

    const leak = await verifyExport(bytes, ['Phone: +1 (555) 123-4567']);
    expect(leak.leakedTerms).toEqual(['Phone: +1 (555) 123-4567']);

    // The other direction, and the one that catches a silent regression: "5.5"
    // does not occur literally, but as a regex `5.5` matches the "555" inside
    // "(555)". Reporting it would be a false alarm; missing the case above would
    // be a false "clean". Both come from the same escaping.
    expect((await verifyExport(bytes, ['5.5'])).leakedTerms).toEqual([]);
  });

  it('separates lines so the next one cannot mask a leaked term', async () => {
    const pristine = await makeTwoLinePdf();
    const doc = await loadPdf(pristine);
    const text = await extractPageText(await doc.getPage(1));
    expect(text.split('\n').map((s) => s.trim())).toContain('Reported by Jane Author');

    // Without the line break the haystack reads "...Jane AuthorSensitive...", and
    // the \W boundary after the term never matches: a surviving name goes unflagged.
    const bytes = await exportRedactedPdf(pristine, doc, []);
    expect((await verifyExport(bytes, ['Jane Author'])).leakedTerms).toEqual(['Jane Author']);
  });

  it('reports progress per page so a long export can show where it is', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    const seen: [number, number][] = [];
    await exportRedactedPdf(pristine, doc, [wholePage1], (done, total) => {
      seen.push([done, total]);
    });
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('refuses an export that would flatten more pages than memory allows', async () => {
    const pristine = await makeTextPdf();
    const doc = await loadPdf(pristine);
    // The guard runs on the number of distinct redacted pages, before any page is
    // rasterized, so it can be exercised without building a 300-page fixture.
    const many: RedactionRect[] = Array.from({ length: 301 }, (_, i) => ({
      page: i + 1,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    }));
    await expect(buildRedactedPdf(pristine, doc, many)).rejects.toThrow(/batches/i);
  });

  it('names the redacted file', () => {
    expect(redactedFileName('report.pdf')).toBe('report-redacted.pdf');
    expect(redactedFileName('report')).toBe('report-redacted.pdf');
  });

  it('downloads bytes as a PDF blob and revokes the object URL', () => {
    // Aimed at `downloadBytes`, which is where this behaviour lives. It used to go
    // through a `downloadPdf` wrapper that only supplied the MIME literal; asserting
    // the blob type now checks the argument rather than a hardcoded string.
    const anchors: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag as 'a');
      if (tag === 'a') anchors.push(el);
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
      downloadBytes(new Uint8Array([37, 80, 68, 70]), 'report-redacted.pdf', 'application/pdf');
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
