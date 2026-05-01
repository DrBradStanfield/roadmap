// V5 — Tightened Timeline Matrix.
// - Fixed 3 value columns: [older recent] [most recent] [NEW ENTRY]
// - Older batches live in a scrollable "history" strip to the left that
//   can be expanded/collapsed. Default collapsed — we show a small "+ N more"
//   chip the user can click to scroll older values into view.
// - Sparkline/trend column is compact (60px), includes status tick.
// - Metric column is narrower; reference label wraps below the name.
// - Works in ~620px. Horizontal scroll only inside the value strip, not the whole card.

function V5_Timeline() {
  const [batches, setBatches] = React.useState(() =>
    HISTORY.map(h => ({ ...h, values: { ...h.values } }))
  );
  const [newBatch, setNewBatch] = React.useState(null);
  const [activeCell, setActiveCell] = React.useState(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const historyStripRef = React.useRef(null);

  const sorted = [...batches].sort((a, b) => a.date.localeCompare(b.date));
  const recent = sorted.slice(-2);           // up to 2 most recent, pinned
  const older = sorted.slice(0, -2);         // everything else, in scroll strip

  const startNewBatch = () => {
    const today = new Date().toISOString().slice(0, 10);
    setNewBatch({ date: today, values: {} });
  };
  const saveNewBatch = () => {
    if (!newBatch || Object.keys(newBatch.values).filter(k => newBatch.values[k] !== '' && newBatch.values[k] != null).length === 0) {
      setNewBatch(null); return;
    }
    const clean = { ...newBatch, values: Object.fromEntries(
      Object.entries(newBatch.values).filter(([_, v]) => v !== '' && v != null).map(([k, v]) => [k, parseFloat(v)])
    )};
    setBatches(b => [...b, clean]);
    setNewBatch(null); setActiveCell(null);
  };
  const cancelNewBatch = () => { setNewBatch(null); setActiveCell(null); };
  const updateDraft = (key, v) => setNewBatch(nb => ({ ...nb, values: { ...nb.values, [key]: v } }));

  const filledCount = newBatch
    ? Object.values(newBatch.values).filter(v => v !== '' && v != null).length : 0;

  // Auto-scroll history strip to the right edge when it opens
  React.useEffect(() => {
    if (historyOpen && historyStripRef.current) {
      historyStripRef.current.scrollLeft = historyStripRef.current.scrollWidth;
    }
  }, [historyOpen]);

  return (
    <div className="bt-root" style={{ width: '100%', height: '100%', background: 'var(--bg)', padding: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: -0.2 }}>Blood Test Results</div>
          <div style={{ fontSize: 11, color: 'var(--ink-500)', marginTop: 2 }}>
            {newBatch
              ? `Entering batch for ${formatDate(newBatch.date)}`
              : `${batches.length} batches · showing 2 most recent${older.length ? ` · ${older.length} older hidden` : ''}`
            }
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {newBatch ? (
            <>
              <button onClick={cancelNewBatch} style={btn5Ghost}>Cancel</button>
              <button onClick={saveNewBatch} disabled={filledCount === 0}
                      style={{ ...btn5Primary, opacity: filledCount === 0 ? 0.5 : 1, cursor: filledCount === 0 ? 'default' : 'pointer' }}>
                Save {filledCount > 0 && `(${filledCount})`}
              </button>
            </>
          ) : (
            <>
              <button style={btn5Ghost}>Upload</button>
              <button onClick={startNewBatch} style={btn5Primary}>+ New entry</button>
            </>
          )}
        </div>
      </div>

      <div style={{
        flex: 1, background: 'var(--paper)', borderRadius: 'var(--r-lg)', border: '1px solid var(--ink-200)',
        boxShadow: 'var(--shadow-1)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden',
      }}>
        <Header5 older={older} recent={recent} newBatch={newBatch} setNewBatch={setNewBatch}
                 historyOpen={historyOpen} setHistoryOpen={setHistoryOpen}
                 historyStripRef={historyStripRef}/>
        <div className="bt-scroll" style={{ overflow: 'auto', flex: 1 }}>
          {METRICS.map((m, i) => (
            <MetricRow5 key={m.key} metric={m}
                        older={older} recent={recent} newBatch={newBatch}
                        activeCell={activeCell} setActiveCell={setActiveCell}
                        updateDraft={updateDraft} isLast={i === METRICS.length - 1}
                        historyOpen={historyOpen} historyStripRef={historyStripRef}/>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--ink-400)', textAlign: 'center' }}>
        Tap "{older.length ? `+${older.length} older` : 'History'}" above to scroll through earlier draws
      </div>
    </div>
  );
}

const btn5Primary = {
  background: 'var(--brand)', color: 'white', border: 'none', borderRadius: 8,
  padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
};
const btn5Ghost = {
  background: 'var(--paper)', color: 'var(--ink-700)', border: '1px solid var(--ink-200)',
  borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
};

// Widths — keep tight. Total fits in ~560–600px.
const COL = {
  name: 130,
  value: 74,      // each value column
  trend: 70,
  rowGap: 1,
};

function Header5({ older, recent, newBatch, setNewBatch, historyOpen, setHistoryOpen, historyStripRef }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch',
      background: 'var(--ink-50)', borderBottom: '1px solid var(--ink-200)',
      fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--ink-500)',
      position: 'sticky', top: 0, zIndex: 3,
    }}>
      <div style={{ width: COL.name, padding: '8px 12px', borderRight: '1px solid var(--ink-100)', display: 'flex', alignItems: 'center' }}>Metric</div>

      {/* History strip (scrollable, collapsible) */}
      <div style={{
        width: historyOpen ? COL.value * 2 + 8 : (older.length ? 56 : 0),
        borderRight: older.length ? '1px solid var(--ink-100)' : 'none',
        transition: 'width .22s ease', overflow: 'hidden', flexShrink: 0,
        display: 'flex', alignItems: 'center',
      }}>
        {older.length > 0 && !historyOpen && (
          <button onClick={() => setHistoryOpen(true)}
            style={{
              width: '100%', height: '100%', background: 'transparent', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
              fontSize: 10, color: 'var(--brand)', fontWeight: 700, letterSpacing: 0.4, fontFamily: 'inherit',
            }}>
            <span>+{older.length}</span>
            <svg width="9" height="9" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>
          </button>
        )}
        {historyOpen && (
          <div ref={historyStripRef} className="bt-scroll" style={{ width: '100%', overflow: 'auto', display: 'flex', alignItems: 'center' }}>
            <button onClick={() => setHistoryOpen(false)}
                    style={{
                      flex: '0 0 22px', height: '100%', background: 'transparent', border: 'none', cursor: 'pointer',
                      color: 'var(--ink-400)', fontFamily: 'inherit',
                    }}>‹</button>
            <div style={{ display: 'flex' }}>
              {older.map((b, i) => (
                <DateCell5 key={i} date={b.date}/>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Recent pinned */}
      {recent.map((b, i) => (
        <DateCell5 key={i} date={b.date} pinned={i === recent.length - 1 && !newBatch}/>
      ))}

      {/* New entry */}
      {newBatch && (
        <div style={{ width: COL.value, padding: '6px 6px', borderLeft: '2px solid var(--brand)', background: 'var(--brand-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <input type="date" value={newBatch.date} onChange={e => setNewBatch(nb => ({ ...nb, date: e.target.value }))}
                 style={{
                   width: '100%', border: 'none', background: 'transparent', color: 'var(--brand)',
                   fontSize: 10, fontWeight: 700, letterSpacing: 0.3, fontFamily: 'inherit',
                   textAlign: 'center', outline: 'none',
                 }}/>
        </div>
      )}

      <div style={{ flex: 1, minWidth: COL.trend, padding: '8px 10px', borderLeft: '1px solid var(--ink-100)', textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Trend</div>
    </div>
  );
}

function DateCell5({ date, pinned }) {
  const d = new Date(date + 'T00:00');
  const day = d.getDate();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  const yr = String(d.getFullYear()).slice(-2);
  return (
    <div style={{
      width: COL.value, padding: '6px 4px', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', borderLeft: '1px solid var(--ink-100)',
      background: pinned ? 'var(--ok-soft)' : 'transparent', flexShrink: 0,
    }}>
      <div style={{ fontSize: 10, color: pinned ? 'var(--ok)' : 'var(--ink-600, #5b6670)', fontWeight: 700 }}>{day} {mon}</div>
      <div style={{ fontSize: 9, color: 'var(--ink-400)', fontWeight: 500, marginTop: 1 }}>'{yr}</div>
    </div>
  );
}

function MetricRow5({ metric, older, recent, newBatch, activeCell, setActiveCell, updateDraft, isLast, historyOpen }) {
  const allReal = [...older, ...recent];
  const seriesPts = allReal
    .map(b => ({ date: b.date, v: b.values[metric.key] }))
    .filter(p => p.v != null);
  const latest = seriesPts[seriesPts.length - 1]?.v;
  const latestStatus = statusOf(metric, latest);

  return (
    <div style={{
      display: 'flex', alignItems: 'stretch',
      borderBottom: isLast ? 'none' : '1px solid var(--ink-100)',
      minHeight: 52,
    }}>
      {/* Metric name */}
      <div style={{ width: COL.name, padding: '10px 12px', borderRight: '1px solid var(--ink-100)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-900)' }}>{metric.name}</div>
        <div style={{ fontSize: 10, color: 'var(--ink-400)', marginTop: 1, lineHeight: 1.3 }}>{metric.unit}</div>
        <div style={{ fontSize: 9, color: 'var(--ink-400)', marginTop: 1, lineHeight: 1.3 }}>{metric.refLabel}</div>
      </div>

      {/* History strip */}
      <div style={{
        width: historyOpen ? COL.value * 2 + 8 : (older.length ? 56 : 0),
        borderRight: older.length ? '1px solid var(--ink-100)' : 'none',
        transition: 'width .22s ease', overflow: 'hidden', flexShrink: 0,
      }}>
        {historyOpen ? (
          <div style={{ width: '100%', height: '100%', overflow: 'hidden', display: 'flex', alignItems: 'center' }}>
            <div style={{ flex: '0 0 22px' }}/>
            <div style={{ display: 'flex', height: '100%' }}>
              {older.map((b, i) => (
                <ValueCell5 key={i} metric={metric} value={b.values[metric.key]}/>
              ))}
            </div>
          </div>
        ) : older.length > 0 ? (
          // Compact sparkline stand-in of older points
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 4, paddingRight: 4 }}>
            <MiniSparkline5 points={older.map(b => b.values[metric.key]).filter(v => v != null)} metric={metric}/>
          </div>
        ) : null}
      </div>

      {/* Recent pinned values */}
      {recent.map((b, i) => (
        <ValueCell5 key={i} metric={metric} value={b.values[metric.key]} latest={i === recent.length - 1 && !newBatch}/>
      ))}

      {/* New entry input */}
      {newBatch && (
        <InputCell5 metric={metric} value={newBatch.values[metric.key] || ''}
                    active={activeCell === metric.key}
                    onFocus={() => setActiveCell(metric.key)} onBlur={() => setActiveCell(null)}
                    onChange={v => updateDraft(metric.key, v)}
                    previous={latest}/>
      )}

      {/* Trend */}
      <div style={{
        flex: 1, minWidth: COL.trend, borderLeft: '1px solid var(--ink-100)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '6px 6px', gap: 2,
      }}>
        <Sparkline metric={metric} width={62} height={18} fill={false}/>
        <span style={{
          width: 18, height: 2.5, borderRadius: 2,
          background: latest != null ? STATUS_COLOR[latestStatus].fg : 'var(--ink-200)',
        }}/>
      </div>
    </div>
  );
}

function ValueCell5({ metric, value, latest }) {
  const status = value != null ? statusOf(metric, value) : 'empty';
  return (
    <div style={{
      width: COL.value, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      borderLeft: '1px solid var(--ink-100)', flexShrink: 0,
      background: latest ? 'var(--ok-soft)' : 'transparent',
    }}>
      {value != null ? (
        <>
          <span className="num" style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)', lineHeight: 1.1 }}>{value}</span>
          <span style={{ width: 14, height: 2.5, borderRadius: 2, background: STATUS_COLOR[status].fg, marginTop: 3, opacity: 0.85 }}/>
        </>
      ) : (
        <span style={{ color: 'var(--ink-300)', fontSize: 13 }}>—</span>
      )}
    </div>
  );
}

function InputCell5({ metric, value, active, onFocus, onBlur, onChange, previous }) {
  const parsed = value !== '' ? parseFloat(value) : null;
  const status = parsed != null && !Number.isNaN(parsed) ? statusOf(metric, parsed) : null;
  return (
    <div style={{
      width: COL.value, padding: '6px 4px',
      borderLeft: '2px solid var(--brand)',
      background: 'rgba(0,163,139,0.05)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, flexShrink: 0,
    }}>
      <input type="number" inputMode="decimal" value={value}
             onChange={e => onChange(e.target.value)} onFocus={onFocus} onBlur={onBlur}
             placeholder={previous != null ? String(previous) : '—'}
             style={{
               width: '100%', border: active ? '1.5px solid var(--brand)' : '1px solid var(--ink-200)',
               borderRadius: 5, padding: '4px 2px', fontSize: 13, fontWeight: 600,
               textAlign: 'center', background: 'var(--paper)', outline: 'none',
               fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums',
             }}/>
      {status && (
        <span style={{ width: 14, height: 2.5, borderRadius: 2, background: STATUS_COLOR[status].fg }}/>
      )}
    </div>
  );
}

function MiniSparkline5({ points, metric }) {
  if (points.length < 2) {
    return <span style={{ fontSize: 10, color: 'var(--ink-300)' }}>—</span>;
  }
  const min = Math.min(...points), max = Math.max(...points);
  const r = max - min || 1;
  const w = 42, h = 14;
  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((v - min) / r) * h;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={coords} fill="none" stroke="var(--ink-300)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function V5_TimelineEntering() {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => { setMounted(true); }, []);
  const ref = React.useRef(null);
  React.useEffect(() => {
    // Auto-click the "+ New entry" button after mount
    if (!mounted) return;
    const t = setTimeout(() => {
      const btn = ref.current?.querySelector('button');
      // find the "+ New entry" button by text
      const btns = ref.current?.querySelectorAll('button') || [];
      for (const b of btns) {
        if (b.textContent.includes('New entry')) { b.click(); break; }
      }
    }, 80);
    return () => clearTimeout(t);
  }, [mounted]);
  return <div ref={ref} style={{ width: '100%', height: '100%' }}><V5_Timeline/></div>;
}
window.V5_TimelineEntering = V5_TimelineEntering;

