import { describe, expect, it } from 'vitest';
import {
  getPageSize,
  loadPdf,
  renderPageToCanvas,
  renderPageToImageCanvas,
} from '../../src/lib/pdf/render';
import { makeTextPdf } from '../support/testpdf';

describe('render', () => {
  it('loads a PDF and reports the page count', async () => {
    const doc = await loadPdf(await makeTextPdf());
    expect(doc.numPages).toBe(2);
  });

  it('reports page size in points', async () => {
    const doc = await loadPdf(await makeTextPdf());
    expect(getPageSize(await doc.getPage(1))).toEqual({ width: 612, height: 792 });
  });

  it('renders a page to an on-screen canvas fitted to a target width', async () => {
    const doc = await loadPdf(await makeTextPdf());
    const canvas = document.createElement('canvas');
    const size = await renderPageToCanvas(await doc.getPage(1), canvas, 400);
    expect(size.cssWidth).toBe(400);
    expect(size.cssHeight).toBeGreaterThan(0);
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.style.width).toBe('400px');
  });

  it('renders a page to a detached image canvas at an explicit scale', async () => {
    const doc = await loadPdf(await makeTextPdf());
    const canvas = await renderPageToImageCanvas(await doc.getPage(1), 2);
    expect(canvas.width).toBe(Math.ceil(612 * 2));
    expect(canvas.height).toBe(Math.ceil(792 * 2));
  });

  async function renderWithDpr(dpr: number): Promise<HTMLCanvasElement> {
    const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });
    try {
      const doc = await loadPdf(await makeTextPdf());
      const canvas = document.createElement('canvas');
      await renderPageToCanvas(await doc.getPage(1), canvas, 400);
      return canvas;
    } finally {
      if (original) Object.defineProperty(window, 'devicePixelRatio', original);
    }
  }

  it('scales the backing store up for HiDPI displays', async () => {
    const canvas = await renderWithDpr(2);
    expect(canvas.width).toBe(800); // 400 CSS px × dpr 2
    expect(canvas.style.width).toBe('400px');
  });

  it('falls back to 1× when the device pixel ratio is unavailable', async () => {
    const canvas = await renderWithDpr(0);
    expect(canvas.width).toBe(400); // 400 × (0 || 1)
  });
});
