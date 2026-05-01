// Shared mock data + helpers for all 4 variations.
// Thresholds mirror packages/health-core/src/units.ts (SI canonical units).
// Band model: optimal[lo,hi] = ok, borderline[lo,hi] = warn, anything else = bad.
// For higherIsBetter, only the LOW edges of each band are used (statusOf below).

// `convert(v, to)`     SI canonical → display unit
// `convertFrom(v, from)` display unit → SI canonical (for inputs typed in alt unit)
// `refLabel` is for SI display; `refLabelAlt` is for alt-unit display.
const METRICS = [
  {
    // HBA1C_THRESHOLDS: prediabetes ~38.8, diabetes ~47.5 (mmol/mol IFCC)
    key: 'hba1c', name: 'HbA1c', unit: 'mmol/mol', altUnit: '%',
    convert: (v, to) => to === '%' ? +(v * 0.09148 + 2.152).toFixed(1) : v,
    convertFrom: (v, from) => from === '%' ? +((v - 2.152) / 0.09148).toFixed(1) : v,
    refLabel: 'Normal: <38.8', refLabelAlt: 'Normal: <5.7%',
    optimal: [0, 38.8], borderline: [38.8, 47.5], category: 'Diabetes',
  },
  {
    key: 'creatinine', name: 'Creatinine', unit: 'µmol/L', altUnit: 'mg/dL',
    convert: (v, to) => to === 'mg/dL' ? +(v / 88.4).toFixed(2) : v,
    convertFrom: (v, from) => from === 'mg/dL' ? +(v * 88.4).toFixed(0) : v,
    refLabel: 'Reference: 60–110', refLabelAlt: 'Reference: 0.7–1.2',
    optimal: [60, 110], borderline: [50, 125], category: 'Kidney',
  },
  {
    // APOB_THRESHOLDS: borderline 0.5, high 0.7, veryHigh 1.0 (g/L)
    key: 'apob', name: 'ApoB', unit: 'g/L', altUnit: 'mg/dL',
    convert: (v, to) => to === 'mg/dL' ? Math.round(v * 100) : v,
    convertFrom: (v, from) => from === 'mg/dL' ? +(v / 100).toFixed(2) : v,
    refLabel: 'Optimal: <0.5', refLabelAlt: 'Optimal: <50',
    optimal: [0, 0.5], borderline: [0.5, 0.7], category: 'Lipids',
  },
  {
    // LDL_THRESHOLDS: borderline ~3.36, high ~4.14, veryHigh ~4.91 (mmol/L)
    key: 'ldl', name: 'LDL Cholesterol', unit: 'mmol/L', altUnit: 'mg/dL',
    convert: (v, to) => to === 'mg/dL' ? Math.round(v * 38.67) : v,
    convertFrom: (v, from) => from === 'mg/dL' ? +(v / 38.67).toFixed(2) : v,
    refLabel: 'Optimal: <3.36', refLabelAlt: 'Optimal: <130',
    optimal: [0, 3.36], borderline: [3.36, 4.14], category: 'Lipids',
  },
  {
    // TOTAL_CHOLESTEROL_THRESHOLDS: borderline ~5.17, high ~6.21 (mmol/L)
    key: 'tc', name: 'Total Cholesterol', unit: 'mmol/L', altUnit: 'mg/dL',
    convert: (v, to) => to === 'mg/dL' ? Math.round(v * 38.67) : v,
    convertFrom: (v, from) => from === 'mg/dL' ? +(v / 38.67).toFixed(2) : v,
    refLabel: 'Optimal: <5.17', refLabelAlt: 'Optimal: <200',
    optimal: [0, 5.17], borderline: [5.17, 6.21], category: 'Lipids',
  },
  {
    // HDL_THRESHOLDS: lowMale ~1.03, lowFemale ~1.29 (mmol/L). Higher is better.
    key: 'hdl', name: 'HDL Cholesterol', unit: 'mmol/L', altUnit: 'mg/dL',
    convert: (v, to) => to === 'mg/dL' ? Math.round(v * 38.67) : v,
    convertFrom: (v, from) => from === 'mg/dL' ? +(v / 38.67).toFixed(2) : v,
    refLabel: 'Optimal: ≥1.29', refLabelAlt: 'Optimal: ≥50',
    optimal: [1.29, 5.0], borderline: [1.03, 1.29], category: 'Lipids',
    higherIsBetter: true,
  },
  {
    // TRIGLYCERIDES_THRESHOLDS: borderline ~1.69, high ~2.26 (mmol/L)
    key: 'tg', name: 'Triglycerides', unit: 'mmol/L', altUnit: 'mg/dL',
    convert: (v, to) => to === 'mg/dL' ? Math.round(v * 88.57) : v,
    convertFrom: (v, from) => from === 'mg/dL' ? +(v / 88.57).toFixed(2) : v,
    refLabel: 'Normal: <1.69', refLabelAlt: 'Normal: <150',
    optimal: [0, 1.69], borderline: [1.69, 2.26], category: 'Lipids',
  },
  {
    // LPA_THRESHOLDS: normal 75, elevated 125 (nmol/L)
    key: 'lpa', name: 'Lp(a)', unit: 'nmol/L', altUnit: 'nmol/L',
    convert: v => v,
    convertFrom: v => v,
    refLabel: 'Normal: <75', refLabelAlt: 'Normal: <75',
    optimal: [0, 75], borderline: [75, 125], category: 'Lipids',
  },
];

// 5 historical draws (chronological, oldest first). Values calibrated against
// real SI thresholds: a mix of ok/warn/bad to exercise status colors visually.
const HISTORY = [
  // ok-leaning baseline
  { date: '2024-03-12', values: { hba1c: 35, creatinine: 88, apob: 0.62, ldl: 3.1, tc: 4.8, hdl: 1.35, tg: 1.4, lpa: 42 } },
  // borderline drift
  { date: '2024-09-03', values: { hba1c: 39, creatinine: 92, apob: 0.55, ldl: 3.5, tc: 5.3, hdl: 1.20, tg: 1.7, lpa: 44 } },
  // worse — into bad band on a few; lpa not measured this draw
  { date: '2025-04-22', values: { hba1c: 49, creatinine: 95, apob: 0.78, ldl: 4.3, tc: 6.4, hdl: 1.00, tg: 2.4 } },
  // partial recovery after intervention
  { date: '2025-10-14', values: { hba1c: 44, creatinine: 102, apob: 0.48, ldl: 3.0, tc: 4.9, hdl: 1.30, tg: 1.5, lpa: 45 } },
  // newest — only HbA1c measured this draw (sparse-row case)
  { date: '2026-04-01', values: { hba1c: 38, creatinine: undefined, apob: undefined, ldl: undefined, tc: undefined, hdl: undefined, tg: undefined, lpa: undefined } },
];

// Status helper
function statusOf(metric, v) {
  if (v == null || Number.isNaN(v)) return 'empty';
  const [optLo, optHi] = metric.optimal;
  const [brdLo, brdHi] = metric.borderline;
  if (metric.higherIsBetter) {
    if (v >= optLo) return 'ok';
    if (v >= brdLo) return 'warn';
    return 'bad';
  }
  if (v >= optLo && v <= optHi) return 'ok';
  if (v >= brdLo && v <= brdHi) return 'warn';
  return 'bad';
}

const STATUS_LABEL = { ok: 'Optimal', warn: 'Borderline', bad: 'Out of range', empty: '—' };
const STATUS_COLOR = {
  ok:   { fg: 'var(--ok)',   bg: 'var(--ok-soft)'   },
  warn: { fg: 'var(--warn)', bg: 'var(--warn-soft)' },
  bad:  { fg: 'var(--bad)',  bg: 'var(--bad-soft)'  },
  empty:{ fg: 'var(--ink-400)', bg: 'var(--ink-100)' },
};

function formatDate(iso, opts = {}) {
  const d = new Date(iso + 'T00:00');
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  if (opts.short) return `${d.getDate()} ${m}`;
  return `${d.getDate()} ${m} ${d.getFullYear()}`;
}

function seriesFor(metric) {
  return HISTORY
    .map(h => ({ date: h.date, v: h.values[metric.key] }))
    .filter(p => p.v != null);
}

// Tiny SVG sparkline
function Sparkline({ metric, width = 72, height = 22, stroke, showDot = true, fill = true }) {
  const pts = seriesFor(metric);
  if (pts.length < 2) {
    return (
      <svg width={width} height={height} style={{display:'block'}}>
        <line x1="0" y1={height/2} x2={width} y2={height/2}
              stroke="var(--ink-200)" strokeDasharray="2 3" strokeWidth="1"/>
      </svg>
    );
  }
  const vals = pts.map(p => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const pad = 3;
  const w = width - pad*2, h = height - pad*2;
  const coords = pts.map((p, i) => {
    const x = pad + (i / (pts.length - 1)) * w;
    const y = pad + h - ((p.v - min) / range) * h;
    return [x, y];
  });
  const d = coords.map((c, i) => (i === 0 ? `M${c[0]},${c[1]}` : `L${c[0]},${c[1]}`)).join(' ');
  const last = coords[coords.length - 1];
  const last2 = coords[pts.length - 1];
  const lastStatus = statusOf(metric, pts[pts.length - 1].v);
  const dotColor = stroke || STATUS_COLOR[lastStatus].fg;
  const strokeColor = stroke || 'var(--ink-400)';
  const areaPath = `${d} L${last[0]},${height-pad} L${pad},${height-pad} Z`;
  return (
    <svg width={width} height={height} style={{display:'block'}}>
      {fill && <path d={areaPath} fill="var(--ink-100)" opacity="0.7"/>}
      <path d={d} fill="none" stroke={strokeColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      {showDot && <circle cx={last2[0]} cy={last2[1]} r="2.5" fill={dotColor}/>}
    </svg>
  );
}

// Mini ref-range gauge — a horizontal track with 3 segments + needle
function RangeGauge({ metric, value, width = 100, height = 6 }) {
  if (value == null) return null;
  // Map domain: scale from 0 to 1.5 * borderline high (or 2x optimal for higherIsBetter)
  const domainMax = metric.higherIsBetter ? metric.optimal[1] * 1.3 : metric.borderline[1] * 1.2;
  const pct = x => Math.max(0, Math.min(100, (x / domainMax) * 100));
  const okLo = pct(metric.optimal[0]);
  const okHi = pct(metric.optimal[1]);
  const warnLo = pct(metric.borderline[0]);
  const warnHi = pct(metric.borderline[1]);
  const needle = pct(value);
  const status = statusOf(metric, value);
  return (
    <div style={{position:'relative', width, height, borderRadius: height, background:'var(--bad-soft)', overflow:'visible'}}>
      <div style={{position:'absolute', left:`${warnLo}%`, width:`${warnHi-warnLo}%`, top:0, bottom:0, background:'var(--warn-soft)'}}/>
      <div style={{position:'absolute', left:`${okLo}%`, width:`${okHi-okLo}%`, top:0, bottom:0, background:'var(--ok-soft)'}}/>
      <div style={{
        position:'absolute', left:`calc(${needle}% - 2px)`, top:-2, width:4, height:height+4,
        borderRadius:2, background:STATUS_COLOR[status].fg, boxShadow:'0 0 0 1.5px var(--paper)'
      }}/>
    </div>
  );
}

// Expose globals for babel-split files
Object.assign(window, {
  METRICS, HISTORY, statusOf, STATUS_LABEL, STATUS_COLOR, formatDate, seriesFor,
  Sparkline, RangeGauge,
});
