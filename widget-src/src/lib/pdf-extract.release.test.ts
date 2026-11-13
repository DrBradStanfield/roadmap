/**
 * US-12 AC7a: every PDF the upload reads releases its pdf.js document, and with it
 * the worker pdf.js started for that document, whether the read succeeds or fails.
 * Before, nothing destroyed the loading task, so each PDF of an upload left a live
 * worker holding its file for the rest of the page's life.
 *
 * Real pdf.js on synthetic PDFs. Node has no Web Worker, so pdf.js runs its worker
 * code in-process (`globalThis.pdfjsWorker`); the loading task is the same object a
 * browser gets. Each test checks both that the task was destroyed (`destroyed` turns
 * true as soon as its `destroy()` starts) and that its `PDFWorker` was then told to
 * shut down (`PDFWorker.destroy()`, which terminates the Web Worker in a browser).
 * The browser check in the PR body counts the workers themselves.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFWorker, type PDFDocumentLoadingTask } from 'pdfjs-dist';

const tasks: PDFDocumentLoadingTask[] = [];
/** Runs as each loading task is made: a test aborts its read there, mid-read. */
let onTask: (() => void) | null = null;
vi.mock('pdfjs-dist', async importOriginal => {
  const real = await importOriginal<typeof import('pdfjs-dist')>();
  return {
    ...real,
    getDocument: (...args: Parameters<typeof real.getDocument>) => {
      const task = real.getDocument(...args);
      tasks.push(task);
      onTask?.();
      return task;
    },
  };
});

const { extractFromPdf } = await import('./pdf-extract');
const workerDestroy = vi.spyOn(PDFWorker.prototype, 'destroy');

/** A one-page PDF: `content` is the page's content stream (Helvetica as /F1). */
function onePagePdf(content: string): File {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const at = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([body], 'report.pdf', { type: 'application/pdf' });
}

const textPdf = () => onePagePdf('BT /F1 12 Tf 72 700 Td (Synthetic report: LDL 3.1 mmol/L, HbA1c 38 mmol/mol, collected 2026-01-15.) Tj ET');

beforeAll(async () => {
  // pdf.js ships no types for its worker build; a non-literal specifier keeps tsc from asking for them.
  const workerBuild = 'pdfjs-dist/build/pdf.worker.mjs';
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import(/* @vite-ignore */ workerBuild);
});
beforeEach(() => {
  tasks.length = 0;
  onTask = null;
  workerDestroy.mockClear();
});

describe('US-12 AC7a: a PDF read by the upload releases its pdf.js worker', () => {
  it('after a text PDF is read', async () => {
    const { pages } = await extractFromPdf(textPdf());
    expect(pages).toEqual([expect.objectContaining({ type: 'text', content: expect.stringContaining('LDL 3.1 mmol/L') })]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].destroyed).toBe(true);
    expect(workerDestroy).toHaveBeenCalledTimes(1);
  });

  it('after each of several PDFs, as in one upload', async () => {
    for (let i = 0; i < 3; i++) await extractFromPdf(textPdf());
    expect(tasks.map(t => t.destroyed)).toEqual([true, true, true]);
    expect(workerDestroy).toHaveBeenCalledTimes(3);
  });

  it('after a page fails to render (a scanned page with no canvas to draw on)', async () => {
    // No text layer, so the page is rendered; Node has no `document`, so rendering throws,
    // as a browser does when it cannot give the canvas a 2D context.
    await expect(extractFromPdf(onePagePdf('0 0 m 100 100 l S'))).rejects.toThrow('document is not defined');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].destroyed).toBe(true);
    expect(workerDestroy).toHaveBeenCalledTimes(1);
  });

  it('after a file that is not a PDF fails to open', async () => {
    await expect(extractFromPdf(new File(['not a pdf at all'], 'report.pdf', { type: 'application/pdf' }))).rejects.toThrow('Invalid PDF structure');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].destroyed).toBe(true);
    expect(workerDestroy).toHaveBeenCalledTimes(1);
  });
});

/** A signal as Safari before 15.4 has it: no `throwIfAborted`. */
const oldSafariSignal = (stop = new AbortController()) => Object.defineProperty(stop.signal, 'throwIfAborted', { value: undefined });

describe('US-12 AC7b (U15): a PDF read stopped at the upload\'s time limit releases its worker then', () => {
  it('an abort during the read stops it and destroys the loading task', async () => {
    const stop = new AbortController();
    onTask = () => queueMicrotask(() => stop.abort()); // just after the task is made, while pdf.js opens the file
    await expect(extractFromPdf(textPdf(), stop.signal)).rejects.toThrow();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].destroyed).toBe(true);
    expect(workerDestroy).toHaveBeenCalled();
  });

  it('a read already stopped before it starts opens nothing', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(extractFromPdf(textPdf(), stop.signal)).rejects.toThrow();
    expect(tasks).toHaveLength(0);
  });

  it('a signal without throwIfAborted (Safari before 15.4) still reads, and still stops when aborted', async () => {
    const { pages } = await extractFromPdf(textPdf(), oldSafariSignal());
    expect(pages).toEqual([expect.objectContaining({ type: 'text', content: expect.stringContaining('LDL 3.1 mmol/L') })]);
    const stop = new AbortController();
    stop.abort();
    await expect(extractFromPdf(textPdf(), oldSafariSignal(stop))).rejects.toThrow('stopped');
  });

  it('a signal that never fires changes nothing', async () => {
    const { pages } = await extractFromPdf(textPdf(), new AbortController().signal);
    expect(pages).toEqual([expect.objectContaining({ type: 'text', content: expect.stringContaining('LDL 3.1 mmol/L') })]);
    expect(tasks[0].destroyed).toBe(true);
  });
});
