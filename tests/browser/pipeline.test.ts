import { describe, expect, it } from 'vitest';
import { downloadBytes, exportRedactedPdf, redactedFileName } from '../../src/lib/pdf/export';
import { buildRedactedPdf } from '../../src/lib/pdf/redact';
import { loadPdf } from '../../src/lib/pdf/render';
import { collectRedactedText, extractAllText } from '../../src/lib/pdf/textlayer';
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

  it('names and downloads the redacted file', () => {
    expect(redactedFileName('report.pdf')).toBe('report-redacted.pdf');
    expect(redactedFileName('report')).toBe('report-redacted.pdf');
    expect(() => downloadBytes(new Uint8Array([37, 80, 68, 70]), 'x-redacted.pdf')).not.toThrow();
  });
});
