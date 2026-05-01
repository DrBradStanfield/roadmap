// V4 — Results Ledger with compare-on-entry.
// - Left pane: vertical ledger of metrics with current value + sparkline + range bar.
// - Right pane: entry dock. When any metric is focused, it shows the full history
//   for THAT metric inline with the draft value live-previewed as a new point,
//   trendline redrawn, and delta surfaced. You see consequences as you type.
// - One global date per entry session, editable per-row via a subtle override.

function V4_Ledger() {
  const [dataset, setDataset] = React.useState(() => HISTORY.map(h => ({ ...h, values: { ...h.values } })));
  const [mode, setMode] = React.useState('view'); // 'view' | 'entry'
  const [sessionDate, setSessionDate] = React.useState('2026-04-22');
  const [drafts, setDrafts] = React.useState({}); // { metricKey: { value, dateOverride? } }
  const [focusKey, setFocusKey] = React.useState(null);

  const startEntry = () => { setMode('entry'); setDrafts({}); setFocusKey(METRICS[0].key); };
  const cancelEntry = () => { setMode('view'); setDrafts({}); setFocusKey(null); };
  const commitEntry = () => {
    const filled = Object.entries(drafts).filter(([_, d]) => d.value !== '' && !Number.isNaN(parseFloat(d.value)));
    if (filled.length === 0) { cancelEntry(); return; }
    // Group by date (session date or per-row override)
    const byDate = {};
    filled.forEach(([k, d]) => {
      const date = d.dateOverride || sessionDate;
      (byDate[date] ||= {})[k] = parseFloat(d.value);
    });
    const newBatches = Object.entries(byDate).map(([date, values]) => ({ date, values }));
    setDataset(ds => [...ds, ...newBatches].sort((a, b) => a.date.localeCompare(b.date)));
    setMode('view'); setDrafts({}); setFocusKey(null);
  };

  const updateDraft = (key, patch) => setDrafts(d => ({ ...d, [key]: { value: '', ...d[key], ...patch } }));

  const filledCount = Object.values(drafts).filter(d => d.value !== '' && !Number.isNaN(parseFloat(d.value))).length;

  return (
    <div className="bt-root" style={{ width: '100%', height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TopBar mode={mode} sessionDate={sessionDate} setSessionDate={setSessionDate}
              filledCount={filledCount} onStart={startEntry} onCancel={cancelEntry} onCommit={commitEntry}/>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: mode === 'entry' ? '1fr 1fr' : '1fr', minHeight: 0, gap: 1, background: 'var(--ink-100)' }}>
        <Ledger dataset={dataset} drafts={drafts} focusKey={focusKey} setFocusKey={setFocusKey}
                mode={mode} updateDraft={updateDraft} sessionDate={sessionDate}/>
        {mode === 'entry' && focusKey && (
          <PreviewPane metric={METRICS.find(m => m.key === focusKey)}
                       dataset={dataset} draft={drafts[focusKey]}
                       sessionDate={sessionDate}
                       onOverrideDate={(d) => updateDraft(focusKey, { dateOverride: d })}/>
        )}
      </div>
    </div>
  );
}

function TopBar({ mode, sessionDate, setSessionDate, filledCount, onStart, onCancel, onCommit }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 20px', background: 'var(--paper)', borderBottom: '1px solid var(--ink-200)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--brand)', display: 'grid', placeItems: 'center', color: 'white', fontWeight: 700, fontSize: 13 }}>β</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: -0.2 }}>Blood test ledger</div>
          <div style={{ fontSize: 11, color: 'var(--ink-500)', marginTop: 1 }}>
            {mode === 'view' ? '8 metrics tracked · 5 draws since Mar 2024' : `Drafting ${filledCount} value${filledCount === 1 ? '' : 's'} · ${formatDate(sessionDate)}`}
          </div>
        </div>
      </div>
      {mode === 'view' ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnGhostV4}>Upload records</button>
          <button onClick={onStart} style={btnPrimaryV4}>+ Enter results</button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{ fontSize: 11, color: 'var(--ink-500)', fontWeight: 500 }}>Draw date</label>
          <input type="date" value={sessionDate} onChange={e => setSessionDate(e.target.value)}
                 style={{ border: '1px solid var(--ink-200)', borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit' }}/>
          <button onClick={onCancel} style={btnGhostV4}>Cancel</button>
          <button onClick={onCommit} disabled={filledCount === 0}
                  style={{ ...btnPrimaryV4, opacity: filledCount === 0 ? 0.5 : 1 }}>
            Save {filledCount > 0 && `· ${filledCount}`}
          </button>
        </div>
      )}
    </div>
  );
}

const btnPrimaryV4 = {
  background: 'var(--brand)', color: 'white', border: 'none', borderRadius: 8,
  padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
};
const btnGhostV4 = {
  background: 'transparent', color: 'var(--ink-700)', border: '1px solid var(--ink-200)', borderRadius: 8,
  padding: '6px 13px', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
};

function Ledger({ dataset, drafts, focusKey, setFocusKey, mode, updateDraft, sessionDate }) {
  return (
    <div className="bt-scroll" style={{ background: 'var(--paper)', overflow: 'auto', padding: '4px 0' }}>
      {METRICS.map((m, i) => {
        const series = dataset.map(b => ({ date: b.date, v: b.values[m.key] })).filter(p => p.v != null);
        const last = series[series.length - 1];
        const prev = series[series.length - 2];
        const status = last ? statusOf(m, last.v) : 'empty';
        const info = STATUS_COLOR[status];
        const isFocused = focusKey === m.key;
        const draft = drafts[m.key] || { value: '' };
        const hasDraft = draft.value !== '' && !Number.isNaN(parseFloat(draft.value));
        const draftStatus = hasDraft ? statusOf(m, parseFloat(draft.value)) : null;

        return (
          <div key={m.key} onClick={() => mode === 'entry' && setFocusKey(m.key)}
               style={{
                 padding: '14px 20px', borderTop: i === 0 ? 'none' : '1px solid var(--ink-100)',
                 background: isFocused ? 'var(--brand-tint)' : 'transparent',
                 borderLeft: isFocused ? '2px solid var(--brand)' : '2px solid transparent',
                 cursor: mode === 'entry' ? 'pointer' : 'default',
                 transition: 'background .15s',
               }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: '0 0 120px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-900)' }}>{m.name}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-400)', marginTop: 2 }}>{m.refLabel} {m.unit}</div>
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                {mode === 'entry' ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, position: 'relative' }}>
                      <input type="number" inputMode="decimal" value={draft.value}
                             onChange={e => updateDraft(m.key, { value: e.target.value })}
                             onFocus={() => setFocusKey(m.key)}
                             placeholder={last ? `Previous: ${last.v} ${m.unit}` : 'Enter value'}
                             style={{
                               width: '100%', padding: '7px 56px 7px 10px', fontSize: 14, fontWeight: 600,
                               border: isFocused ? '1.5px solid var(--brand)' : '1px solid var(--ink-200)',
                               borderRadius: 6, outline: 'none', background: 'var(--paper)',
                               fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums',
                             }}/>
                      <span style={{
                        position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                        fontSize: 10, color: 'var(--ink-400)', pointerEvents: 'none',
                      }}>{m.unit}</span>
                    </div>
                    {hasDraft && (
                      <span style={{
                        fontSize: 9, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
                        padding: '3px 7px', borderRadius: 999,
                        color: STATUS_COLOR[draftStatus].fg, background: STATUS_COLOR[draftStatus].bg,
                      }}>{STATUS_LABEL[draftStatus]}</span>
                    )}
                  </div>
                ) : last ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="num" style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>{last.v}</span>
                    <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>{m.unit}</span>
                    {prev && (
                      <span style={{ fontSize: 11, color: 'var(--ink-500)', marginLeft: 4 }}>
                        {last.v > prev.v ? '↑' : last.v < prev.v ? '↓' : '='} from {prev.v}
                      </span>
                    )}
                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Sparkline metric={m} width={90} height={24} stroke={info.fg}/>
                      <span style={{
                        fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
                        padding: '3px 7px', borderRadius: 999, color: info.fg, background: info.bg,
                      }}>{STATUS_LABEL[status]}</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--ink-400)' }}>No readings yet</div>
                )}

                <div style={{ marginTop: 8 }}>
                  <RangeGauge metric={m} value={hasDraft ? parseFloat(draft.value) : last?.v} width={260} height={5}/>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PreviewPane({ metric, dataset, draft, sessionDate, onOverrideDate }) {
  const series = dataset.map(b => ({ date: b.date, v: b.values[metric.key] })).filter(p => p.v != null);
  const draftVal = draft && draft.value !== '' ? parseFloat(draft.value) : null;
  const effectiveDate = draft?.dateOverride || sessionDate;
  const previewPoint = draftVal != null && !Number.isNaN(draftVal) ? { date: effectiveDate, v: draftVal, draft: true } : null;
  const allPoints = previewPoint ? [...series, previewPoint].sort((a, b) => a.date.localeCompare(b.date)) : series;
  const last = series[series.length - 1];
  const delta = previewPoint && last ? previewPoint.v - last.v : null;
  const draftStatus = previewPoint ? statusOf(metric, previewPoint.v) : null;
  const improving = delta != null && (metric.higherIsBetter ? delta > 0 : delta < 0);

  return (
    <div style={{ background: 'var(--paper)', padding: '18px 22px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--ink-400)' }}>Live preview</div>
        <div style={{ fontSize: 18, fontWeight: 700, marginTop: 3, letterSpacing: -0.3 }}>{metric.name}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-500)', marginTop: 2 }}>{metric.refLabel} {metric.unit}</div>
      </div>

      {previewPoint ? (
        <div style={{ padding: 14, borderRadius: 12, background: STATUS_COLOR[draftStatus].bg, border: `1px solid ${STATUS_COLOR[draftStatus].fg}22` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span className="num" style={{ fontSize: 34, fontWeight: 700, letterSpacing: -1, color: STATUS_COLOR[draftStatus].fg }}>{draftVal}</span>
            <span style={{ fontSize: 12, color: 'var(--ink-500)' }}>{metric.unit}</span>
            {delta != null && delta !== 0 && (
              <span style={{
                marginLeft: 'auto', fontSize: 12, fontWeight: 700,
                color: improving ? 'var(--ok)' : 'var(--bad)',
              }}>
                {delta > 0 ? '↑' : '↓'} {Math.abs(delta).toFixed(2).replace(/\.00$/,'')} vs {last.v}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-500)', marginTop: 4 }}>
            New {STATUS_LABEL[draftStatus].toLowerCase()} reading on {formatDate(effectiveDate)}
          </div>
        </div>
      ) : (
        <div style={{ padding: 14, borderRadius: 12, background: 'var(--ink-50)', border: '1px dashed var(--ink-200)', color: 'var(--ink-400)', fontSize: 12, textAlign: 'center' }}>
          Start typing to see a live preview
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--ink-400)', marginBottom: 8 }}>Trend — {series.length} readings</div>
        <BigChart metric={metric} points={allPoints} previewPoint={previewPoint}/>
      </div>

      <div style={{ borderTop: '1px solid var(--ink-100)', paddingTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>Was this on a different day?</span>
        <input type="date" value={effectiveDate} onChange={e => onOverrideDate(e.target.value)}
               style={{ border: '1px solid var(--ink-200)', borderRadius: 6, padding: '4px 8px', fontSize: 11, fontFamily: 'inherit' }}/>
        {draft?.dateOverride && draft.dateOverride !== sessionDate && (
          <button onClick={() => onOverrideDate(null)} style={{
            background: 'transparent', border: 'none', color: 'var(--brand)', fontSize: 11, cursor: 'pointer',
          }}>Reset to session</button>
        )}
      </div>
    </div>
  );
}

function BigChart({ metric, points, previewPoint }) {
  if (points.length < 1) return <div style={{ height: 200, display: 'grid', placeItems: 'center', color: 'var(--ink-400)', fontSize: 12 }}>No data</div>;
  const w = 560, h = 220, padY = 28, padX = 36;
  const vals = points.map(p => p.v);
  const [optLo, optHi] = metric.optimal;
  const [brdLo, brdHi] = metric.borderline;
  const vmin = Math.min(...vals, optLo, brdLo) * 0.88;
  const vmax = Math.max(...vals, optHi, brdHi) * 1.12;
  const range = vmax - vmin || 1;
  const y = v => padY + (h - padY * 2) - ((v - vmin) / range) * (h - padY * 2);
  const dates = points.map(p => new Date(p.date + 'T00:00').getTime());
  const tmin = Math.min(...dates), tmax = Math.max(...dates);
  const tr = tmax - tmin || 1;
  const x = ms => padX + ((ms - tmin) / tr) * (w - padX * 2);

  const optY1 = y(optLo), optY2 = y(optHi);
  const okTop = Math.min(optY1, optY2), okH = Math.abs(optY2 - optY1);
  const brdY1 = y(brdLo), brdY2 = y(brdHi);
  const brdTop = Math.min(brdY1, brdY2), brdH = Math.abs(brdY2 - brdY1);

  const coords = points.map(p => [x(new Date(p.date + 'T00:00').getTime()), y(p.v), p]);
  const realCoords = coords.filter(c => !c[2].draft);
  const pathReal = realCoords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c[0]},${c[1]}`).join(' ');
  const draftCoord = coords.find(c => c[2].draft);
  const lastReal = realCoords[realCoords.length - 1];
  const pathDraft = draftCoord && lastReal ? `M${lastReal[0]},${lastReal[1]} L${draftCoord[0]},${draftCoord[1]}` : null;

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', background: 'var(--ink-50)', borderRadius: 10 }}>
      {/* Bands */}
      <rect x={padX} y={brdTop} width={w - padX*2} height={brdH} fill="var(--warn-soft)" opacity="0.5"/>
      <rect x={padX} y={okTop} width={w - padX*2} height={okH} fill="var(--ok-soft)" opacity="0.7"/>
      <line x1={padX} x2={w-padX} y1={okTop} y2={okTop} stroke="var(--ok)" strokeDasharray="3 3" strokeWidth="0.8" opacity="0.7"/>
      <line x1={padX} x2={w-padX} y1={okTop+okH} y2={okTop+okH} stroke="var(--ok)" strokeDasharray="3 3" strokeWidth="0.8" opacity="0.7"/>

      {/* Labels */}
      <text x={padX+4} y={okTop+okH/2+3} fontSize="9" fill="var(--ok)" fontWeight="700">OPTIMAL</text>
      <text x={w-padX-4} y={padY-4} textAnchor="end" fontSize="9" fill="var(--ink-400)">{vmax.toFixed(1)}</text>
      <text x={w-padX-4} y={h-padY+12} textAnchor="end" fontSize="9" fill="var(--ink-400)">{vmin.toFixed(1)} {metric.unit}</text>

      {/* Real path */}
      {pathReal && <path d={pathReal} fill="none" stroke="var(--ink-700)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>}
      {/* Draft path */}
      {pathDraft && <path d={pathDraft} fill="none" stroke="var(--brand)" strokeWidth="2" strokeDasharray="5 4" strokeLinecap="round"/>}

      {/* Points */}
      {coords.map((c, i) => {
        const p = c[2];
        const s = statusOf(metric, p.v);
        if (p.draft) {
          return (
            <g key={i}>
              <circle cx={c[0]} cy={c[1]} r="10" fill={STATUS_COLOR[s].fg} opacity="0.15"/>
              <circle cx={c[0]} cy={c[1]} r="6" fill="var(--paper)" stroke={STATUS_COLOR[s].fg} strokeWidth="2.5"/>
              <circle cx={c[0]} cy={c[1]} r="2.5" fill={STATUS_COLOR[s].fg}/>
            </g>
          );
        }
        return <circle key={i} cx={c[0]} cy={c[1]} r="4" fill="var(--paper)" stroke={STATUS_COLOR[s].fg} strokeWidth="2"/>;
      })}

      {/* x-axis date labels (first & last) */}
      <text x={coords[0][0]} y={h-padY+22} textAnchor="middle" fontSize="9" fill="var(--ink-500)">{formatDate(coords[0][2].date, {short: true})}</text>
      {coords.length > 1 && (
        <text x={coords[coords.length-1][0]} y={h-padY+22} textAnchor="middle" fontSize="9" fill="var(--ink-500)" fontWeight={coords[coords.length-1][2].draft ? 700 : 400}>
          {formatDate(coords[coords.length-1][2].date, {short: true})}
          {coords[coords.length-1][2].draft && ' (new)'}
        </text>
      )}
    </svg>
  );
}

window.V4_Ledger = V4_Ledger;
