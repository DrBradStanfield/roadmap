// A page that draws the unmounted web upload list over the real engine, for screenshots and real-WebKit checks (web
// list PR 2). Not shipped: no build entry names upload-list-harness.html; serve it with Vite (the PR body says how).
// `?s=` picks a scenario; `window.uploadListHost` sends engine events. Synthetic values only.
import { createRoot } from 'react-dom/client';
import { core, DAY, EMPTY, extra, NOW } from '@roadmap/health-core/import-review.test-helpers';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import { bulkAppendValues } from '@roadmap/health-core/record-edits';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import { transition, type UploadState } from '@roadmap/health-core/upload-flow';
import type { CellUnit } from '@roadmap/health-core/cell-unit';
import type { MetricType } from '@roadmap/health-core/units';
import { UploadListHost, type ListHost } from './upload-list-host';
import '../styles.css';

type Open = Extract<UploadState, { phase: 'open' }>;
type File = Open['files'][number];
const x = (over: Partial<UnifiedExtractionResult>): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over });
const read = (id: string, name: string, extraction: UnifiedExtractionResult): File =>
  ({ id, name, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices: NO_CHOICES } });
const open = (files: File[]): Open => ({ phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: NOW });

const REPORT = x({
  values: [
    core({ confidence: 'medium' }),
    core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', question: 'Is this HbA1c or glucose?' }),
    core({ metric: 'creatinine', valueSI: 80, displayValue: 80, displayUnit: 'µmol/L' }),
  ],
  additionalValues: [extra(), extra({ name: 'Vitamin B12', value: 300, unit: 'pmol/L' })],
});
const fresh = open([read('f0', 'blood-tests-nov.pdf', REPORT)]);
const chose = (s: UploadState, change: Parameters<typeof transition>[1] & { type: 'chose' }) => transition(s, change).state;

const TWO_LDL = open([read('f0', 'blood-tests-nov.pdf', x({ values: [core({}), core({ valueSI: 2.9, displayValue: 2.9, recordedAt: '2026-09-15' }), core({ metric: 'lpa', valueSI: 90, displayValue: 90, displayUnit: 'nmol/L' })] }))]);
const SCENARIOS: Record<string, { s: UploadState; record: RoadmapFile; unitOf?: (m: MetricType) => CellUnit }> = {
  fresh: { s: fresh, record: EMPTY },
  held: { s: chose(fresh, { type: 'chose', id: 'f0', change: { typed: 'v0', text: '3..1', unit: 'si' }, now: NOW }), record: EMPTY },
  conflict: { s: fresh, record: bulkAppendValues(EMPTY, [{ kind: 'measurement', metricType: 'ldl', value: 2.9, recordedAt: DAY, source: 'manual' }], NOW).file },
  waiting: { s: open([read('f0', 'scan-no-date.pdf', x({ reportDate: null, values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })], additionalValues: [extra()] }))]), record: EMPTY },
  letter: { s: open([read('f0', 'blood-tests-nov.pdf', REPORT), read('f1', 'cardiology-clinic.pdf', x({ classification: 'clinic_letter', reportDate: null,
    document: { classification: 'clinic_letter', title: 'Cardiology clinic follow-up', documentDate: '2026-10-20', metadata: {},
      contentMarkdown: '## Cardiology clinic\n\nSeen today for follow-up. Blood pressure well controlled.\n\n**Plan:** repeat lipids in three months.' } }))]), record: EMPTY },
  columns: { s: open([read('f0', 'blood-tests-nov.pdf', x({ values: [core({}), core({ valueSI: 2.9, displayValue: 2.9, recordedAt: '2026-09-15' }), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' }), core({ metric: 'hba1c', valueSI: 42, displayValue: 42, displayUnit: 'mmol/mol', recordedAt: '2026-09-15' })] }))]), record: EMPTY },
  notsaved: { s: open([read('f0', 'blood-tests-nov.pdf', x({ values: [core({})], unreadValues: [{ name: 'Vitamin D', reason: 'unreadable' }], refusedValues: [{ metric: 'creatinine', value: 3, unit: 'mmol/24h', reason: 'unit' }] }))]), record: EMPTY },
  // Held text typed in mmol/L, then LDL switched to mg/dL on the other row: the held row keeps its unit.
  unitheld: { s: chose(TWO_LDL, { type: 'chose', id: 'f0', change: { typed: 'v0', text: '3..1', unit: 'si' }, now: NOW }), record: EMPTY, unitOf: (m) => (m === 'ldl' ? 'conventional' : 'si') },
  units: { s: TWO_LDL, record: EMPTY },
  futureday: { s: chose(open([read('f0', 'scan-no-date.pdf', x({ reportDate: null, values: [core({})] }))]), { type: 'chose', id: 'f0', change: { testDay: '2026-12-01' }, now: NOW }), record: EMPTY },
  done: { s: { ...fresh, phase: 'done', outcome: { values: 4, documents: 1, archived: 1, skippedValues: 1 } }, record: EMPTY },
  // A file still reading before one already read: its rows land above the focused row (the WebKit focus check).
  reorder: { s: open([{ ...read('f0', 'first.pdf', REPORT), status: { s: 'sending', attempt: 1 } }, read('f1', 'second.pdf', x({ values: [core({ valueSI: 500, displayValue: 500 })] }))]), record: EMPTY },
};

declare global { interface Window { uploadListHost?: ListHost; uploadListReport?: UnifiedExtractionResult } }
const scenario = SCENARIOS[new URLSearchParams(location.search).get('s') ?? 'fresh'] ?? SCENARIOS.fresh;
const host = { current: null as ListHost | null };
window.uploadListReport = REPORT;
createRoot(document.getElementById('root')!).render(
  <div className="health-tool">
    <div className="upload-modal" style={{ margin: '0 auto', maxHeight: 'none', boxShadow: 'none' }}>
      <div className="upload-modal-header"><h3>Upload Health Records</h3></div>
      <div className="upload-modal-body">
        <UploadListHost initial={scenario.s} record={scenario.record} now={NOW} host={host} unitOf={scenario.unitOf} />
      </div>
    </div>
  </div>,
);
Object.defineProperty(window, 'uploadListHost', { get: () => host.current ?? undefined });
