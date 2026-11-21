// Test support for the web upload list's component tests (web list PR 2): synthetic reads, the host mounted over the
// real engine, and the person's steps. Not shipped: only tests import it. Synthetic values only.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { DAY, EMPTY, NOW } from '@roadmap/health-core/import-review.test-helpers';
import type { CellUnit } from '@roadmap/health-core/cell-unit';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import type { BulkRow } from '@roadmap/health-core/record-edits';
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import type { MetricType } from '@roadmap/health-core/units';
import { UploadListHost, type ListHost } from './upload-list-host';

export type Open = Extract<UploadState, { phase: 'open' }>;
export const labRead = (id: string, over: Partial<UnifiedExtractionResult>, name = `${id}.pdf`): Open['files'][number] => ({
  id, name, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over }, choices: NO_CHOICES },
});
export const letterRead = (id: string, title: string, name = `${id}.pdf`): Open['files'][number] => ({
  id, name, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', choices: NO_CHOICES, extraction: { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
    document: { classification: 'clinic_letter', title, documentDate: '2026-10-20', contentMarkdown: 'Plan', metadata: {} } } },
});
export const open = (files: Open['files']): Open => ({ phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: NOW });
export const LDL = (value: number, recordedAt = DAY): BulkRow => ({ kind: 'measurement', metricType: 'ldl', value, recordedAt, source: 'manual' });

export function mount(s: UploadState, record = EMPTY, unitOf: (m: MetricType) => CellUnit = () => 'si') {
  const host = { current: null as ListHost | null };
  const view = render(<UploadListHost initial={s} record={record} now={NOW} host={host} unitOf={unitOf} />);
  return Object.assign(host.current!, { unmount: view.unmount });
}
export const row = (key: string) => document.querySelector<HTMLLIElement>(`li[data-key="${key}"]`)!;
export const input = (key: string) => within(row(key)).getByRole('textbox') as HTMLInputElement;
export const typeInto = (key: string, text: string) => {
  act(() => input(key).focus());
  fireEvent.change(input(key), { target: { value: text } });
};
export const blur = () => act(() => (document.activeElement as HTMLElement).blur());
export const save = () => document.querySelector<HTMLButtonElement>('.review-save-btn')!;
export const showAll = () => fireEvent.click(screen.getByRole('button', { name: /^Show all/ }));
