// A page that mounts the real upload modal (mount 3b) over a real record in memory, for screenshots and real-WebKit
// checks. Not shipped: no build entry names upload-modal-harness.html; serve it with Vite rooted at widget-src. Every
// read is synthetic: `fetch` to the lab-import endpoint is answered here and nothing leaves the page; the upload bundle
// is a stand-in whose page text is the file's name, with the real shared engine. `?s=` picks a scenario. No real record.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FIELD_METRIC_MAP } from '@roadmap/health-core/mappings';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import type { MetricType, UnitSystem } from '@roadmap/health-core/units';
import { UploadModal } from '../components/UploadModal';
import { initRoadmapStore } from '../lib/roadmap-data';
import { BACKEND_KEY } from '../storage/web-record-host';
import { RoadmapStore } from '../storage/roadmap-store';
import { UPLOAD_ENGINE } from './upload-engine';
import '../styles.css';

const DAY = '2026-11-01';
const core = (metric: string, v: number, more: object = {}) => ({ metric, valueSI: v, displayValue: v, displayUnit: metric.endsWith('_bp') ? 'mmHg' : 'mmol/L', confidence: 'high', ...more });
const lab = (reportDate: string | null, values: unknown[], additionalValues: unknown[] = []) => ({ classification: 'lab_report', document: null, reportDate, values, additionalValues });
const letter = (title: string, metadata: object = {}) => ({
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [],
  document: { classification: 'clinic_letter', title, documentDate: '2026-10-20', contentMarkdown: 'Synthetic letter text. Seen in clinic; no change to plan.', metadata },
});
/** Each file's synthetic read, by its name (the stand-in bundle's page text). */
const READS: Record<string, object> = {
  'blood-tests-nov.pdf': lab(DAY, [core('ldl', 2.8, { confidence: 'medium', question: 'Is this LDL or total cholesterol?' }), core('hdl', 1.4), core('lpa', 90, { displayUnit: 'nmol/L' })], [{ name: 'Ferritin', value: 80, unit: 'µg/L', referenceLow: 30, referenceHigh: 300 }]),
  'colonoscopy-letter.pdf': letter('Synthetic colonoscopy report', { screeningType: 'colorectal' }),
  'conflict.pdf': lab(DAY, [core('ldl', 3.5), core('hdl', 1.4)]),
  'undated.pdf': lab(null, [core('ldl', 3.1)], [{ name: 'Ferritin', value: 60, unit: 'µg/L' }]),
  'clean.pdf': lab(DAY, [core('hdl', 1.4), core('triglycerides', 1.1)]),
  'slow.pdf': lab(DAY, [core('hdl', 1.3)]),
};
const SCENARIOS: Record<string, { files: string[]; held?: boolean; save?: 'hang' | 'throw'; refuseOriginals?: boolean }> = {
  review: { files: ['blood-tests-nov.pdf', 'colonoscopy-letter.pdf'] },
  conflict: { files: ['conflict.pdf'], held: true },
  undated: { files: ['undated.pdf'] },
  clean: { files: ['clean.pdf'] },
  reading: { files: ['clean.pdf', 'slow.pdf'] },
  saving: { files: ['clean.pdf'], save: 'hang' },
  failed: { files: ['clean.pdf'], save: 'throw' },
  unstored: { files: ['clean.pdf', 'colonoscopy-letter.pdf'], refuseOriginals: true },
  large: { files: ['clean.pdf', 'big-scan.pdf'] },
};
const name = new URLSearchParams(location.search).get('s') ?? 'review';
const scenario = SCENARIOS[name] ?? SCENARIOS.review;

// The lab-import endpoint, answered here: the quota allows, and each page's text names its read. `slow.pdf` waits.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes('/api/lab-import-v2')) return realFetch(input, init);
  if (!init || init.method !== 'POST') return new Response(JSON.stringify({ allowed: true, remaining: 60 }), { headers: { 'content-type': 'application/json' } });
  const page = (JSON.parse(String(init.body)) as { pages: Array<{ content: string }> }).pages[0].content;
  if (page === 'slow.pdf') await new Promise((r) => setTimeout(r, 600_000));
  return new Response(JSON.stringify({ success: true, data: READS[page] }), { headers: { 'content-type': 'application/json' } });
};
Object.assign(window, { HealthUpload: {
  ...UPLOAD_ENGINE,
  isPdf: (f: File) => f.name.endsWith('.pdf'), isZip: () => false, isImage: () => false,
  extractFromPdf: async (f: File) => ({ pages: [{ type: 'text', content: f.name }], truncated: false }),
} });

class HarnessCloud extends MemoryAdapter {
  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    if (scenario.refuseOriginals) throw new Error('Synthetic: the cloud refused the original');
    return super.writeDocument(ref, bytes);
  }
}

async function start() {
  localStorage.clear();
  localStorage.setItem(BACKEND_KEY, 'memory');
  const cloud = new MemoryCloud();
  const seed = await RoadmapStore.create(new MemoryAdapter(cloud));
  if (scenario.held) seed.addMeasurement('ldl', 2.8, DAY);
  await seed.flush();
  if (scenario.save === 'hang') RoadmapStore.prototype.saveUpload = () => new Promise(() => {});
  if (scenario.save === 'throw') RoadmapStore.prototype.saveUpload = async () => { throw new Error('Synthetic: the store threw'); };
  await initRoadmapStore(new HarnessCloud(cloud));
  createRoot(document.getElementById('root')!).render(<Page />);
  // The person's pick, once the dropzone is drawn.
  const pick = () => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]');
    if (!input) return void setTimeout(pick, 50);
    const files = new DataTransfer();
    // A `big-` file is over the 10 MB cap, never read (US-12 AC9).
    for (const f of scenario.files) files.items.add(new File([f.startsWith('big-') ? new Uint8Array(11 * 1024 * 1024) : f], f, { type: 'application/pdf' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  pick();
}

function Page() {
  const [open, setOpen] = useState(true);
  const [units, setUnits] = useState<Partial<Record<MetricType, UnitSystem>>>({});
  return (
    <div className="health-tool">
      <button type="button" onClick={() => setOpen(true)}>Upload lab results</button>
      <UploadModal
        open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} onComplete={() => {}}
        unitSystem="si" metricUnitOverrides={units} age={55} sex="female"
        onSetFieldUnit={(field, to) => setUnits((u) => ({ ...u, [FIELD_METRIC_MAP[field] as MetricType]: to }))}
      />
    </div>
  );
}

void start();
