// V6 — Starting Info / Vitals card.
// Three independent mini-timelines (Weight, Waist, BP) inside one card.
// Each metric has its own dates — they're not shared.

const VITALS_METRICS = [
  {
    key: 'weight', name: 'Weight', unit: 'kg', altUnit: 'lb',
    convert: (v, to) => to === 'lb' ? Math.round(v * 2.205) : v,
    refLabel: 'Tracking weekly is ideal',
    optimal: [55, 85], borderline: [50, 95],
    sample: [
      { date: '2025-10-04', v: 88 },
      { date: '2025-11-15', v: 86 },
      { date: '2025-12-27', v: 85 },
      { date: '2026-02-10', v: 84 },
      { date: '2026-04-22', v: 83 },
    ],
  },
  {
    key: 'waist', name: 'Waist Circumference', unit: 'cm', altUnit: 'in',
    convert: (v, to) => to === 'in' ? +(v / 2.54).toFixed(1) : v,
    refLabel: 'Target: <94 cm (men), <80 cm (women)',
    optimal: [70, 94], borderline: [94, 102],
    sample: [
      { date: '2025-09-12', v: 96 },
      { date: '2025-12-03', v: 94 },
      { date: '2026-03-18', v: 91 },
    ],
  },
  {
    key: 'bp', name: 'Blood Pressure', unit: 'mmHg', altUnit: 'mmHg',
    isBP: true,
    convert: v => v,
    refLabel: 'Target: <120/80 mmHg',
    sample: [
      { date: '2026-01-08', sys: 132, dia: 88 },
      { date: '2026-02-14', sys: 128, dia: 85 },
      { date: '2026-03-20', sys: 124, dia: 82 },
      { date: '2026-05-01', sys: 122, dia: 80 },
    ],
  },
];

function bpStatus(sys, dia) {
  if (sys == null || dia == null) return 'empty';
  if (sys < 120 && dia < 80) return 'ok';
  if (sys < 130 && dia < 85) return 'warn';
  return 'bad';
}
function valStatus(metric, v) {
  if (v == null) return 'empty';
  const [optLo, optHi] = metric.optimal;
  const [brdLo, brdHi] = metric.borderline;
  if (v >= optLo && v <= optHi) return 'ok';
  if (v >= brdLo && v <= brdHi) return 'warn';
  return 'bad';
}

function fmt(iso, opts={}) {
  const d = new Date(iso + 'T00:00');
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  if (opts.short) return `${d.getDate()} ${m}`;
  return `${d.getDate()} ${m} ${d.getFullYear()}`;
}

// ── V6 Variant A: three mini-timelines stacked in one card ──
function V6_VitalsMatrix() {
  const [data, setData] = React.useState(() =>
    Object.fromEntries(VITALS_METRICS.map(m => [m.key, [...m.sample]]))
  );
  const [drafts, setDrafts] = React.useState({}); // per-metric drafts
  const [historyOpen, setHistoryOpen] = React.useState({});

  const updateDraft = (key, patch) => setDrafts(d => ({ ...d, [key]: { value: '', sys: '', dia: '', date: new Date().toISOString().slice(0,10), ...d[key], ...patch } }));
  const saveDraft = (metric) => {
    const d = drafts[metric.key] || {};
    if (metric.isBP) {
      const sys = parseFloat(d.sys), dia = parseFloat(d.dia);
      if (Number.isNaN(sys) || Number.isNaN(dia)) return;
      setData(prev => ({ ...prev, [metric.key]: [...prev[metric.key], { date: d.date, sys, dia }].sort((a,b)=>a.date.localeCompare(b.date)) }));
    } else {
      const v = parseFloat(d.value);
      if (Number.isNaN(v)) return;
      setData(prev => ({ ...prev, [metric.key]: [...prev[metric.key], { date: d.date, v }].sort((a,b)=>a.date.localeCompare(b.date)) }));
    }
    setDrafts(prev => { const n = { ...prev }; delete n[metric.key]; return n; });
  };

  return (
    <div className="bt-root" style={{ width: '100%', height: '100%', background: '#f6f8f7', padding: 18, overflow: 'auto' }}>
      <SectionHeader stage={1} title="YOUR INFORMATION"/>
      <div style={vitalsCardShell}>
        <CollapsedDemographics/>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>
          {VITALS_METRICS.map(m => (
            <VitalsRow6 key={m.key} metric={m}
                        readings={data[m.key]}
                        draft={drafts[m.key]}
                        historyOpen={!!historyOpen[m.key]}
                        toggleHistory={() => setHistoryOpen(h => ({ ...h, [m.key]: !h[m.key] }))}
                        onDraftChange={patch => updateDraft(m.key, patch)}
                        onSave={() => saveDraft(m)}/>
          ))}
        </div>
      </div>
    </div>
  );
}

const vitalsCardShell = {
  background: 'var(--paper)', borderRadius: 14, padding: 18,
  boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
};

function SectionHeader({ stage, title }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '0 2px' }}>
      <div style={{
        width: 24, height: 24, borderRadius: '50%',
        background: 'var(--brand-soft, #e6f5f2)', color: 'var(--brand)',
        display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700,
      }}>{stage}</div>
      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: 1, color: 'var(--ink-500)' }}>{title}</div>
    </div>
  );
}

function CollapsedDemographics() {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--ink-100)', paddingBottom: 14 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 22, fontWeight: 600, color: 'var(--ink-900)', letterSpacing: -0.3 }}>
          Starting Info
          <svg width="12" height="12" viewBox="0 0 10 10" style={{ marginLeft: 2 }}><path d="M3 1l4 4-4 4" stroke="var(--ink-400)" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-500)', marginTop: 4 }}>Male · 183 cm tall · Born Jan 1990 (Age 36)</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--ink-500)' }}>Units</span>
        <span style={{ fontSize: 11, color: 'var(--brand)', border: '1px solid #d7efe9', borderRadius: 12, padding: '2px 10px' }}>Metric (kg, cm, mmol/L)</span>
      </div>
    </div>
  );
}

// One row per metric — its own dates, its own entry column
function VitalsRow6({ metric, readings, draft, historyOpen, toggleHistory, onDraftChange, onSave }) {
  const sorted = readings.slice().sort((a,b)=>a.date.localeCompare(b.date));
  const recent = sorted.slice(-2);
  const older = sorted.slice(0, -2);
  const latest = sorted[sorted.length - 1];
  const filled = metric.isBP
    ? (draft && draft.sys !== '' && draft.dia !== '' && draft.sys != null && draft.dia != null && !Number.isNaN(parseFloat(draft.sys)) && !Number.isNaN(parseFloat(draft.dia)))
    : (draft && draft.value !== '' && draft.value != null && !Number.isNaN(parseFloat(draft.value)));

  return (
    <div>
      {/* Row label + Save */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)' }}>{metric.name}</span>
          <span style={{
            fontSize: 10, color: 'var(--brand)', border: '1px solid #d7efe9',
            borderRadius: 10, padding: '1px 7px', fontWeight: 500,
          }}>{metric.unit}</span>
        </div>
        {filled && (
          <button onClick={onSave} style={saveBtn6}>Save</button>
        )}
      </div>

      <div style={{
        display: 'flex', alignItems: 'stretch',
        border: '1px solid var(--ink-100)', borderRadius: 10, overflow: 'hidden',
      }}>
        {/* Older history toggle */}
        {older.length > 0 && (
          <div style={{
            width: historyOpen ? 80 * older.length + 28 : 38,
            borderRight: '1px solid var(--ink-100)', overflow: 'hidden', flexShrink: 0,
            transition: 'width .22s ease', display: 'flex', alignItems: 'stretch',
          }}>
            {!historyOpen ? (
              <button onClick={toggleHistory} style={v6HistoryToggleBtn}>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--brand)' }}>+{older.length}</span>
                <svg width="9" height="9" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>
              </button>
            ) : (
              <div style={{ display: 'flex', flex: 1 }}>
                <button onClick={toggleHistory} style={{ ...v6HistoryToggleBtn, width: 22, padding: 0 }}>‹</button>
                <div className="bt-scroll" style={{ display: 'flex', overflow: 'auto' }}>
                  {older.map((p, i) => (
                    <DateValueCell6 key={i} metric={metric} reading={p}/>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Recent pinned */}
        {recent.map((p, i) => (
          <DateValueCell6 key={i} metric={metric} reading={p} latest={i === recent.length - 1}/>
        ))}

        {/* New entry column */}
        <NewEntryCell6 metric={metric} draft={draft || {}} onChange={onDraftChange}/>

        {/* Trend */}
        <div style={{
          flex: 1, minWidth: 70, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', borderLeft: '1px solid var(--ink-100)',
          padding: '6px 8px', gap: 2, background: '#fafbfb',
        }}>
          <MiniSparkline6 readings={sorted} metric={metric}/>
          <span style={{ fontSize: 9, color: 'var(--ink-400)', letterSpacing: 0.4, textTransform: 'uppercase', fontWeight: 600 }}>
            {sorted.length} readings
          </span>
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--ink-400)', marginTop: 5, marginLeft: 2 }}>
        {metric.refLabel}
      </div>
    </div>
  );
}

const COLW = 80;

function DateValueCell6({ metric, reading, latest }) {
  const status = metric.isBP
    ? bpStatus(reading.sys, reading.dia)
    : valStatus(metric, reading.v);
  const color = {
    ok: '#2f9e75', warn: '#c58b2a', bad: '#c65454', empty: '#a9b0b6',
  }[status];
  const displayVal = metric.isBP
    ? `${reading.sys}/${reading.dia}`
    : reading.v;
  return (
    <div style={{
      width: COLW, padding: '8px 6px',
      borderLeft: '1px solid var(--ink-100)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: latest ? '#e7f4ef' : 'transparent', flexShrink: 0, gap: 2,
    }}>
      <div style={{ fontSize: 9, color: latest ? '#2f9e75' : 'var(--ink-500)', fontWeight: 700, letterSpacing: 0.3 }}>
        {fmt(reading.date, { short: true })}
      </div>
      <div className="num" style={{ fontSize: metric.isBP ? 13 : 15, fontWeight: 700, color: 'var(--ink-900)' }}>
        {displayVal}
      </div>
      <span style={{ width: 16, height: 2.5, borderRadius: 2, background: color, opacity: 0.85 }}/>
    </div>
  );
}

function NewEntryCell6({ metric, draft, onChange }) {
  const date = draft.date || new Date().toISOString().slice(0,10);
  return (
    <div style={{
      width: metric.isBP ? COLW + 16 : COLW,
      padding: '6px 6px',
      borderLeft: '2px solid var(--brand)',
      background: 'rgba(0,163,139,0.06)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0,
    }}>
      <input type="date" value={date} onChange={e => onChange({ date: e.target.value })}
             style={{
               width: '100%', border: 'none', background: 'transparent', color: 'var(--brand)',
               fontSize: 9, fontWeight: 700, letterSpacing: 0.3, textAlign: 'center', outline: 'none',
               fontFamily: 'inherit', padding: 0,
             }}/>
      {metric.isBP ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%' }}>
          <input type="number" inputMode="numeric" value={draft.sys ?? ''} placeholder="sys"
                 onChange={e => onChange({ sys: e.target.value })}
                 style={v6MiniInput}/>
          <span style={{ color: 'var(--ink-400)' }}>/</span>
          <input type="number" inputMode="numeric" value={draft.dia ?? ''} placeholder="dia"
                 onChange={e => onChange({ dia: e.target.value })}
                 style={v6MiniInput}/>
        </div>
      ) : (
        <input type="number" inputMode="decimal" value={draft.value ?? ''} placeholder="—"
               onChange={e => onChange({ value: e.target.value })}
               style={{ ...v6MiniInput, width: '100%' }}/>
      )}
    </div>
  );
}

const v6MiniInput = {
  flex: 1, minWidth: 0, border: '1px solid var(--ink-200)', borderRadius: 5,
  padding: '4px 4px', fontSize: 13, fontWeight: 700, textAlign: 'center',
  background: 'var(--paper)', outline: 'none', fontFamily: 'inherit',
  fontVariantNumeric: 'tabular-nums', minHeight: 26,
};

const saveBtn6 = {
  background: 'var(--brand)', color: 'white', border: 'none', borderRadius: 6,
  padding: '4px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
};

const v6HistoryToggleBtn = {
  flex: 1, width: '100%', height: '100%', background: 'transparent', border: 'none',
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2,
  color: 'var(--ink-400)', fontFamily: 'inherit',
};

function MiniSparkline6({ readings, metric }) {
  if (readings.length < 2) return <span style={{ fontSize: 11, color: 'var(--ink-300)' }}>—</span>;
  const vals = metric.isBP ? readings.map(r => r.sys) : readings.map(r => r.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const r = max - min || 1;
  const w = 56, h = 18;
  const d = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * w;
    const y = h - ((v - min) / r) * h;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const lastVal = vals[vals.length - 1];
  const status = metric.isBP
    ? bpStatus(readings[readings.length - 1].sys, readings[readings.length - 1].dia)
    : valStatus(metric, lastVal);
  const color = { ok: '#2f9e75', warn: '#c58b2a', bad: '#c65454', empty: '#a9b0b6' }[status];
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx={(vals.length - 1) / (vals.length - 1) * w} cy={h - ((lastVal - min) / r) * h} r="2.2" fill={color}/>
    </svg>
  );
}

// ── V6 Variant B: Compact row, tap to expand inline ──
function V6_VitalsCompact() {
  const [data, setData] = React.useState(() =>
    Object.fromEntries(VITALS_METRICS.map(m => [m.key, [...m.sample]]))
  );
  const [openKey, setOpenKey] = React.useState(null);
  const [draft, setDraft] = React.useState({});

  const startEdit = (key) => {
    setOpenKey(key);
    setDraft({ value: '', sys: '', dia: '', date: new Date().toISOString().slice(0,10) });
  };
  const cancel = () => setOpenKey(null);
  const save = (metric) => {
    if (metric.isBP) {
      const sys = parseFloat(draft.sys), dia = parseFloat(draft.dia);
      if (Number.isNaN(sys) || Number.isNaN(dia)) return;
      setData(d => ({ ...d, [metric.key]: [...d[metric.key], { date: draft.date, sys, dia }].sort((a,b)=>a.date.localeCompare(b.date)) }));
    } else {
      const v = parseFloat(draft.value);
      if (Number.isNaN(v)) return;
      setData(d => ({ ...d, [metric.key]: [...d[metric.key], { date: draft.date, v }].sort((a,b)=>a.date.localeCompare(b.date)) }));
    }
    setOpenKey(null);
  };

  return (
    <div className="bt-root" style={{ width: '100%', height: '100%', background: '#f6f8f7', padding: 18, overflow: 'auto' }}>
      <SectionHeader stage={1} title="YOUR INFORMATION"/>
      <div style={vitalsCardShell}>
        <CollapsedDemographics/>
        <div style={{ marginTop: 8 }}>
          {VITALS_METRICS.map((m, i) => {
            const readings = data[m.key].slice().sort((a,b)=>a.date.localeCompare(b.date));
            const last = readings[readings.length - 1];
            const isOpen = openKey === m.key;
            return (
              <div key={m.key} style={{
                borderTop: i === 0 ? 'none' : '1px solid var(--ink-100)',
                padding: '14px 0',
                background: isOpen ? '#fafdfb' : 'transparent',
                margin: isOpen ? '0 -8px' : 0,
                paddingLeft: isOpen ? 8 : 0, paddingRight: isOpen ? 8 : 0,
                borderRadius: isOpen ? 8 : 0,
                transition: 'background .15s',
              }}>
                {!isOpen ? (
                  <CompactRowB metric={m} last={last} readings={readings} onAdd={() => startEdit(m.key)}/>
                ) : (
                  <ExpandedRowB metric={m} last={last} readings={readings} draft={draft} setDraft={setDraft}
                                onSave={() => save(m)} onCancel={cancel}/>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CompactRowB({ metric, last, readings, onAdd }) {
  const display = metric.isBP ? (last ? `${last.sys}/${last.dia}` : '—') : (last ? last.v : '—');
  const status = last
    ? (metric.isBP ? bpStatus(last.sys, last.dia) : valStatus(metric, last.v))
    : 'empty';
  const colorMap = { ok: '#2f9e75', warn: '#c58b2a', bad: '#c65454', empty: '#a9b0b6' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: '0 0 150px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)' }}>{metric.name}</span>
          <span style={{ fontSize: 10, color: 'var(--brand)', border: '1px solid #d7efe9', borderRadius: 10, padding: '1px 6px', fontWeight: 500 }}>{metric.unit}</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--ink-400)', marginTop: 2 }}>{metric.refLabel}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        <span className="num" style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink-900)' }}>{display}</span>
        <span style={{ width: 14, height: 2.5, borderRadius: 2, background: colorMap[status], marginLeft: 4 }}/>
        {last && <span style={{ fontSize: 11, color: 'var(--ink-400)', marginLeft: 6 }}>{fmt(last.date, { short: true })}</span>}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <MiniSparkline6 readings={readings} metric={metric}/>
        <button onClick={onAdd} style={{
          background: 'transparent', color: 'var(--brand)', border: '1px solid var(--ink-200)',
          borderRadius: 6, padding: '5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 3, fontFamily: 'inherit',
        }}>
          <svg width="9" height="9" viewBox="0 0 10 10"><path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          New
        </button>
      </div>
    </div>
  );
}

function ExpandedRowB({ metric, last, readings, draft, setDraft, onSave, onCancel }) {
  const canSave = metric.isBP
    ? (draft.sys && draft.dia && !Number.isNaN(parseFloat(draft.sys)) && !Number.isNaN(parseFloat(draft.dia)))
    : (draft.value && !Number.isNaN(parseFloat(draft.value)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)' }}>{metric.name}</span>
          <span style={{ fontSize: 10, color: 'var(--brand)', border: '1px solid #d7efe9', borderRadius: 10, padding: '1px 6px', fontWeight: 500 }}>{metric.unit}</span>
          {last && <span style={{ fontSize: 11, color: 'var(--ink-400)', marginLeft: 6, fontStyle: 'italic' }}>Previous: {metric.isBP ? `${last.sys}/${last.dia}` : last.v} · {fmt(last.date, { short: true })}</span>}
        </div>
        <MiniSparkline6 readings={readings} metric={metric}/>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {metric.isBP ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 2 }}>
            <input autoFocus type="number" inputMode="numeric" value={draft.sys ?? ''} placeholder="Systolic"
                   onChange={e => setDraft(d => ({ ...d, sys: e.target.value }))}
                   style={v6FullInput}/>
            <span style={{ fontSize: 16, color: 'var(--ink-400)' }}>/</span>
            <input type="number" inputMode="numeric" value={draft.dia ?? ''} placeholder="Diastolic"
                   onChange={e => setDraft(d => ({ ...d, dia: e.target.value }))}
                   style={v6FullInput}/>
          </div>
        ) : (
          <input autoFocus type="number" inputMode="decimal" value={draft.value ?? ''} placeholder={`Enter ${metric.name.toLowerCase()}`}
                 onChange={e => setDraft(d => ({ ...d, value: e.target.value }))}
                 onKeyDown={e => e.key === 'Enter' && canSave && onSave()}
                 style={{ ...v6FullInput, flex: 2 }}/>
        )}
        <input type="date" value={draft.date} onChange={e => setDraft(d => ({ ...d, date: e.target.value }))}
               style={{ ...v6FullInput, flex: 1, fontSize: 12 }}/>
        <button onClick={onCancel} style={{ ...saveBtn6, background: 'transparent', color: 'var(--ink-500)', border: '1px solid var(--ink-200)' }}>Cancel</button>
        <button onClick={onSave} disabled={!canSave}
                style={{ ...saveBtn6, opacity: canSave ? 1 : 0.5, cursor: canSave ? 'pointer' : 'default' }}>Save</button>
      </div>
    </div>
  );
}

const v6FullInput = {
  border: '1px solid var(--ink-200)', borderRadius: 6, padding: '7px 9px',
  fontSize: 14, fontWeight: 600, outline: 'none', background: 'var(--paper)',
  fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums', minWidth: 0,
};

window.V6_VitalsMatrix = V6_VitalsMatrix;
window.V6_VitalsCompact = V6_VitalsCompact;
