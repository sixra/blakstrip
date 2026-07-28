import { describe, expect, it } from 'vitest';
import { auditDocument } from '../../src/lib/pdf/audit';
import { loadPdf } from '../../src/lib/pdf/render';
import { makeScanLikePdf, makeTextPdf } from '../support/testpdf';

describe('audit', () => {
  it('reports metadata and a text layer for a text PDF', async () => {
    const pristine = await makeTextPdf();
    const report = await auditDocument(pristine, await loadPdf(pristine));
    expect(report.pageCount).toBe(2);
    expect(report.hasTextLayer).toBe(true);
    expect(report.isLikelyScan).toBe(false);
    expect(report.findings.some((f) => f.category === 'metadata')).toBe(true);
  });

  it('flags a scan with no text layer', async () => {
    const pristine = await makeScanLikePdf();
    const report = await auditDocument(pristine, await loadPdf(pristine));
    expect(report.hasTextLayer).toBe(false);
    expect(report.isLikelyScan).toBe(true);
  });
});
