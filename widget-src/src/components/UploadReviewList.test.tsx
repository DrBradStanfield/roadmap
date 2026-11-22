// @vitest-environment jsdom
/**
 * Mount 3b (docs/drafts/upload-list-mount.md (a), docs/drafts/upload-list-screen.md "For the mount PR"): the list in the
 * upload modal, over the real flow and the real engine. A unit press SETS the unit its chip names (owner ruling 2,
 * US-34 AC7a), Lp(a)'s too; a record change drops a Replace whose target moved (US-13 AC21); a typed correction pressed
 * straight to Save, never blurred, is in what Save is handed (owner ruling 1, US-13 AC12). Synthetic values only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createEmptyFile, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { UPLOAD_ENGINE } from '../testing/upload-engine';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { recordFileSync, saveUpload, setLpaUnit } from '../lib/roadmap-data';
import { showAllValues } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ recordFileSync: vi.fn(() => null), saveUpload: vi.fn(), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(() => null), setLpaUnit: vi.fn(() => true), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', async (original) => ({ ...await original<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async () => 'sha256-synthetic') }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

type Import = Awaited<ReturnType<typeof labImport>>;
const DAY = '2024-06-01';
const read = (values: unknown[]): Import => ({ result: { classification: 'lab_report', document: null, reportDate: DAY, values, additionalValues: [] } }) as unknown as Import;
const core = (metric: string, v: number, unit = 'mmol/L') => ({ metric, valueSI: v, displayValue: v, displayUnit: unit, confidence: 'high' });
const setFieldUnit = vi.fn();

function open(record: RoadmapFile | null = null) {
  vi.mocked(recordFileSync).mockReturnValue(record);
  const view = render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" onSetFieldUnit={setFieldUnit} onComplete={() => {}} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'labs.pdf', { type: 'application/pdf' })] } });
  return view;
}
const row = (key: string) => document.querySelector<HTMLLIElement>(`li[data-key="${key}"]`)!;
/** A record holding one LDL on the report's day, as the store holds a blood test (a core lab row, US-66). */
function heldLdl(value: number, id = 'held-ldl'): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'web', now: '2024-06-02T00:00:00.000Z' });
  file.labValues.push({ id, metricName: 'ldl', value, unit: 'mmol/L', recordedAt: DAY, source: 'manual', status: 'active', correctsId: null, core: true, referenceLow: null, referenceHigh: null, createdAt: '2024-06-02T00:00:00.000Z' } as unknown as RoadmapFile['labValues'][number]);
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(saveUpload).mockResolvedValue({ ok: true, outcome: { values: 1, documents: 0, archived: 0, unstored: 0 }, added: [] });
  Object.assign(window, { HealthUpload: { ...UPLOAD_ENGINE, extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text', content: 'x' }], truncated: false })), isPdf: () => true, isZip: () => false, isImage: () => false } });
});
afterEach(cleanup);

describe('mount 3b: a unit press sets the unit its chip names (owner ruling 2)', () => {
  it('a core value\'s chip sets its field to the unit the chip offers, never a flip of what the page shows', async () => {
    vi.mocked(labImport).mockResolvedValue(read([core('ldl', 2.8)]));
    open();
    await waitFor(() => expect(row('f0:v0')).not.toBeNull());
    showAllValues();
    fireEvent.click(row('f0:v0').querySelector('.bt-unit-chip')!);
    expect(setFieldUnit).toHaveBeenCalledWith('ldlC', 'conventional');
  });

  it('Lp(a)\'s control sets the unit pressed', async () => {
    vi.mocked(labImport).mockResolvedValue(read([core('lpa', 50, 'nmol/L')]));
    open();
    await waitFor(() => expect(row('f0:v0')).not.toBeNull());
    showAllValues();
    fireEvent.click(screen.getByRole('radio', { name: 'mg/dL' }));
    expect(setLpaUnit).toHaveBeenCalledWith('mg/dL');
  });
});

describe('mount 3b: the record the list reads', () => {
  it('US-13 AC21: another writer moves a Replace\'s target: the Replace is dropped and its value unticked', async () => {
    vi.mocked(labImport).mockResolvedValue(read([core('ldl', 3.5)]));
    const view = open(heldLdl(2.8));
    const replace = await waitFor(() => {
      const box = row('f0:v0')?.querySelector<HTMLInputElement>('.upload-list-replace input');
      expect(box).toBeTruthy();
      return box!;
    });
    fireEvent.click(replace);
    expect(replace.checked).toBe(true);
    // The held LDL was corrected elsewhere: the page re-renders with the record the store now holds.
    vi.mocked(recordFileSync).mockReturnValue(heldLdl(2.9, 'corrected-ldl'));
    view.rerender(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" onSetFieldUnit={setFieldUnit} onComplete={() => {}} />);
    await waitFor(() => expect(row('f0:v0').querySelector<HTMLInputElement>('.upload-list-tick')!.checked).toBe(false));
  });

  it('US-13 AC12, AC5: text that is no number blocks Save at its row; a number then saves, pressed without a blur', async () => {
    vi.mocked(labImport).mockResolvedValue(read([core('ldl', 2.8), core('hdl', 1.4)]));
    open();
    await waitFor(() => expect(row('f0:v0')).not.toBeNull());
    showAllValues();
    const input = row('f0:v0').querySelector<HTMLInputElement>('input.upload-list-input')!;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '1.2.3' } });
    const save = screen.getByRole('button', { name: /^Save / });
    fireEvent.click(save);
    expect(saveUpload).not.toHaveBeenCalled();
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(input);
    expect(row('f0:v0').querySelector('.upload-list-error')).not.toBeNull();
    fireEvent.change(input, { target: { value: '3.1' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    const s = vi.mocked(saveUpload).mock.calls[0][1];
    expect(s.phase === 'saving' && s.files[0].status.s === 'read' && s.files[0].status.choices.edits).toEqual({ v0: 3.1 });
  });
});
