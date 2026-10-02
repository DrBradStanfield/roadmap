// Builds sample-lab-report.pdf: an INVENTED one-page lab report for OpenAI's
// app reviewers (US-32 AC38, positive test case 4 in docs/chatgpt-app-listing.md).
// No real person, no real lab. Every name and unit below must resolve in the
// record's catalogue (packages/health-core/src/lab-extraction.ts CORE_METRIC_ALIASES,
// units.ts UNIT_ALIASES, lab-catalog.ts LAB_CATALOG), or file_results refuses the row.
//
// Regenerate: node docs/chatgpt-review/make-sample-lab-report.mjs
// Our own proof runs: node docs/chatgpt-review/make-sample-lab-report.mjs --variant
// writes sample-lab-report-proof.pdf, the same results under another name and a
// week earlier, so the reviewer's file is never filed before the review.
// Uses Playwright's Chromium (a repo devDependency) to print HTML to an A4 PDF
// with a real text layer. The file name is the record's dedup key: keep it.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPORT = {
  lab: 'Example Pathology Laboratory',
  patient: 'SAMPLE, Alex',
  sex: 'Male',
  birthYear: 1979,
  labNumber: 'SAMPLE-0001',
  requestedBy: 'Dr Example Doctor',
  collected: '2026-09-28',
  reported: '2026-09-29',
};

/** Where to write, and the header to print: the reviewer's edition, or the proof variant. */
export function edition(proof) {
  return proof
    ? { out: path.join(HERE, 'sample-lab-report-proof.pdf'), report: { ...REPORT, collected: '2026-09-21', reported: '2026-09-22' } }
    : { out: path.join(HERE, 'sample-lab-report.pdf'), report: REPORT };
}

/** One printed result: name, value, unit and range exactly as they appear on the page. */
export const ROWS = [
  { section: 'Diabetes', name: 'HbA1c', value: '37', unit: 'mmol/mol', range: '20 - 40' },
  { section: 'Lipids', name: 'Total Cholesterol', value: '5.4', unit: 'mmol/L', range: '< 5.5' },
  { section: 'Lipids', name: 'HDL Cholesterol', value: '1.3', unit: 'mmol/L', range: '> 1.0' },
  { section: 'Lipids', name: 'LDL Cholesterol (calc)', value: '3.4', unit: 'mmol/L', range: '< 3.0', flag: 'H' },
  { section: 'Lipids', name: 'Triglycerides', value: '1.5', unit: 'mmol/L', range: '< 1.7' },
  { section: 'Renal', name: 'Creatinine', value: '88', unit: 'umol/L', range: '60 - 110' },
  { section: 'Iron studies', name: 'Ferritin', value: '140', unit: 'ug/L', range: '30 - 500' },
  { section: 'Vitamins', name: 'Vitamin D (25-OH)', value: '72', unit: 'nmol/L', range: '50 - 150' },
];

function html(report) {
  const sections = [...new Set(ROWS.map((r) => r.section))];
  const body = sections.map((s) => `
    <tr class="section"><td colspan="5">${s}</td></tr>
    ${ROWS.filter((r) => r.section === s).map((r) => `
    <tr${r.flag ? ' class="flagged"' : ''}>
      <td>${r.name}</td><td class="num">${r.value}</td><td class="flag">${r.flag ?? ''}</td>
      <td>${r.unit}</td><td>${r.range}</td>
    </tr>`).join('')}`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sample lab report</title><style>
    @page { size: A4; margin: 18mm 16mm; }
    body { font-family: Helvetica, Arial, sans-serif; font-size: 10.5pt; color: #111; margin: 0; }
    .banner { border: 2px solid #b00; color: #b00; font-weight: bold; text-align: center; padding: 6pt; font-size: 12pt; margin-bottom: 14pt; }
    h1 { font-size: 16pt; margin: 0 0 2pt; }
    .sub { color: #555; margin-bottom: 12pt; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 3pt 24pt; border-top: 1px solid #999; border-bottom: 1px solid #999; padding: 8pt 0; margin-bottom: 14pt; }
    .meta b { display: inline-block; width: 92pt; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; border-bottom: 1.5px solid #333; padding: 4pt 6pt; font-size: 9.5pt; }
    td { padding: 4pt 6pt; border-bottom: 1px solid #ddd; }
    td.num { text-align: right; font-weight: bold; width: 50pt; }
    td.flag { width: 24pt; font-weight: bold; color: #b00; }
    tr.section td { font-weight: bold; background: #f0f0f0; border-bottom: none; padding-top: 6pt; }
    .key { margin-top: 10pt; font-size: 9pt; color: #555; }
    .foot { margin-top: 28pt; font-size: 9pt; color: #555; border-top: 1px solid #999; padding-top: 6pt; }
  </style></head><body>
    <div class="banner">SAMPLE REPORT: invented data for app review, not a real patient</div>
    <h1>${report.lab}</h1>
    <div class="sub">Laboratory report: biochemistry</div>
    <div class="meta">
      <div><b>Patient</b> ${report.patient}</div>
      <div><b>Lab number</b> ${report.labNumber}</div>
      <div><b>Sex</b> ${report.sex}</div>
      <div><b>Requested by</b> ${report.requestedBy}</div>
      <div><b>Year of birth</b> ${report.birthYear}</div>
      <div><b>Collected</b> ${report.collected}</div>
      <div><b>Specimen</b> Serum, fasting</div>
      <div><b>Reported</b> ${report.reported}</div>
    </div>
    <table>
      <thead><tr><th>Test</th><th style="text-align:right">Result</th><th>Flag</th><th>Units</th><th>Reference range</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div class="key">H = above the reference range.</div>
    <div class="foot">Every name, value and date on this page is invented. It was made to test the Health by Dr Brad app and describes no real person, laboratory or result.</div>
  </body></html>`;
}

async function main() {
  const { out, report } = edition(process.argv.includes('--variant'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html(report), { waitUntil: 'load' });
    await page.pdf({ path: out, format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
  console.log(`wrote ${out}`);
}

// Run when called directly; importing it (to check ROWS against the catalogue) builds nothing.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
