// V2 — Timeline Matrix (narrow desktop, ~420–480px wide).
// Layout, left-to-right:
//   [Metric name (sticky-left)] [horizontal-scroll strip of older batches → 2 most recent → optional new-entry column] [Trend (sticky-right)]
// - Default scroll position is max-right so the 2 most recent + (if active) the new-entry column are visible.
// - User scrolls left to see older batches.
// - On enter: a "+ New batch" column is appended to the strip and we auto-scroll to it.

// Sized so that at a ~460px container (typical InputPanel column on desktop),
// the visible value strip fits exactly 3 columns — i.e. in entry mode the user
// sees [most_recent-1] [most_recent] [NEW]. Older batches scroll in from the left.
//   name(108) + 3*value(90) + trend(58) = 436px, leaving ~20px peek for scroll affordance.
const V2_COL = {
  name: 108,
  value: 90,
  trend: 58,
  rowMin: 56,
};

function V2_Timeline() {
  const [batches, setBatches] = React.useState(() =>
    HISTORY.map(h => ({ ...h, values: { ...h.values } }))
  );
  const [newBatch, setNewBatch] = React.useState(null);
  const [activeCell, setActiveCell] = React.useState(null);

  const sorted = React.useMemo(
    () => [...batches].sort((a, b) => a.date.localeCompare(b.date)),
    [batches]
  );
  const columns = React.useMemo(
    () => [...sorted, ...(newBatch ? [{ ...newBatch, isNew: true }] : [])],
    [sorted, newBatch]
  );

  const startNewBatch = () => {
    const today = new Date().toISOString().slice(0, 10);
    setNewBatch({ date: today, values: {} });
  };
  const saveNewBatch = () => {
    if (!newBatch) return;
    const filled = Object.entries(newBatch.values)
      .filter(([_, v]) => v !== '' && v != null)
      .map(([k, v]) => [k, parseFloat(v)]);
    if (filled.length === 0) { setNewBatch(null); return; }
    setBatches(b => [...b, { ...newBatch, values: Object.fromEntries(filled) }]);
    setNewBatch(null); setActiveCell(null);
  };
  const cancelNewBatch = () => { setNewBatch(null); setActiveCell(null); };
  const updateDraftValue = (key, v) =>
    setNewBatch(nb => ({ ...nb, values: { ...nb.values, [key]: v } }));

  const filledCount = newBatch
    ? Object.values(newBatch.values).filter(v => v !== '' && v != null).length
    : 0;

  return (
    <div className="bt-root" style={{
      width: '100%', height: '100%', background: 'var(--bg)', padding: 14,
      overflow: 'hidden', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: -0.2 }}>Blood Test Results</div>
          <div style={{ fontSize: 11, color: 'var(--ink-500)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {newBatch
              ? `New entry · ${formatDate(newBatch.date)}`
              : `${batches.length} ${batches.length === 1 ? 'batch' : 'batches'} · scroll ← for older`
            }
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {newBatch ? (
            <>
              <button onClick={cancelNewBatch} style={btnGhostV2}>Cancel</button>
              <button onClick={saveNewBatch} disabled={filledCount === 0}
                      style={{ ...btnPrimaryV2, opacity: filledCount === 0 ? 0.5 : 1, cursor: filledCount === 0 ? 'default' : 'pointer' }}>
                Save{filledCount > 0 ? ` (${filledCount})` : ''}
              </button>
            </>
          ) : (
            <>
              <button style={btnGhostV2}>Upload</button>
              <button onClick={startNewBatch} style={btnPrimaryV2}>+ New entry</button>
            </>
          )}
        </div>
      </div>

      <div style={{
        flex: 1, background: 'var(--paper)', borderRadius: 'var(--r-lg)', border: '1px solid var(--ink-200)',
        boxShadow: 'var(--shadow-1)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden',
      }}>
        <Matrix columns={columns} newBatch={newBatch} setNewBatch={setNewBatch}
                activeCell={activeCell} setActiveCell={setActiveCell}
                updateDraftValue={updateDraftValue}/>
      </div>
    </div>
  );
}

function Matrix({ columns, newBatch, setNewBatch, activeCell, setActiveCell, updateDraftValue }) {
  // Each row has its own horizontal scroll container; we keep them in sync via shared scrollLeft state.
  // This lets sticky metric-name and trend cells live OUTSIDE the scroll viewport (cleaner than CSS sticky-grid).
  const [scrollLeft, setScrollLeft] = React.useState(0);
  const scrollContainersRef = React.useRef([]);
  const headerScrollRef = React.useRef(null);
  const isSyncingRef = React.useRef(false);

  // Sync scroll across all rows + header
  const handleScroll = (e) => {
    if (isSyncingRef.current) return;
    const sl = e.target.scrollLeft;
    isSyncingRef.current = true;
    setScrollLeft(sl);
    [headerScrollRef.current, ...scrollContainersRef.current].forEach(el => {
      if (el && el !== e.target) el.scrollLeft = sl;
    });
    requestAnimationFrame(() => { isSyncingRef.current = false; });
  };

  // After mount or when columns change, scroll to far right (newest visible)
  React.useEffect(() => {
    const targets = [headerScrollRef.current, ...scrollContainersRef.current].filter(Boolean);
    if (targets.length === 0) return;
    const max = targets[0].scrollWidth - targets[0].clientWidth;
    if (max <= 0) return;
    targets.forEach(el => { el.scrollLeft = max; });
    setScrollLeft(max);
  }, [columns.length]);

  const registerRowRef = (idx) => (el) => { scrollContainersRef.current[idx] = el; };

  return (
    <>
      {/* Header row */}
      <div style={{
        display: 'flex', alignItems: 'stretch',
        background: 'var(--ink-50)', borderBottom: '1px solid var(--ink-200)',
        position: 'sticky', top: 0, zIndex: 3,
      }}>
        <div style={{
          width: V2_COL.name, flexShrink: 0, padding: '8px 10px',
          fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--ink-500)',
          display: 'flex', alignItems: 'center',
          borderRight: '1px solid var(--ink-200)',
        }}>Metric</div>

        <div ref={headerScrollRef} onScroll={handleScroll}
             className="bt-scroll-x"
             style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', position: 'relative' }}>
          <div style={{ display: 'flex', minWidth: '100%' }}>
            {columns.map((c, i) => (
              <DateHeaderCell key={i} batch={c} setNewBatch={setNewBatch}
                              isPinnedRecent={!c.isNew && i === columns.length - (newBatch ? 2 : 1)}/>
            ))}
            {/* Add a flex spacer so the last column can scroll fully into view if narrower than container */}
            <div style={{ flex: '1 0 0', minWidth: 0 }}/>
          </div>
        </div>

        <div style={{
          width: V2_COL.trend, flexShrink: 0, padding: '8px 6px',
          fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--ink-500)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderLeft: '1px solid var(--ink-200)',
        }}>Trend</div>
      </div>

      {/* Body — vertical scroll */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {METRICS.map((m, rowIdx) => {
          const seriesPts = seriesFor(m);
          const latest = seriesPts[seriesPts.length - 1]?.v;
          const latestStatus = statusOf(m, latest);
          const isLast = rowIdx === METRICS.length - 1;

          return (
            <div key={m.key} style={{
              display: 'flex', alignItems: 'stretch',
              borderBottom: isLast ? 'none' : '1px solid var(--ink-100)',
              minHeight: V2_COL.rowMin,
            }}>
              {/* Sticky metric name */}
              <div style={{
                width: V2_COL.name, flexShrink: 0, padding: '8px 10px',
                display: 'flex', flexDirection: 'column', justifyContent: 'center',
                borderRight: '1px solid var(--ink-100)',
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-900)', lineHeight: 1.2 }}>{m.name}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-400)', marginTop: 2, lineHeight: 1.2 }}>{m.unit}</div>
                <div style={{ fontSize: 9, color: 'var(--ink-400)', marginTop: 1, lineHeight: 1.2 }}>{m.refLabel}</div>
              </div>

              {/* Scrollable values strip */}
              <div ref={registerRowRef(rowIdx)} onScroll={handleScroll}
                   className="bt-scroll-x"
                   style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden' }}>
                <div style={{ display: 'flex', minWidth: '100%', height: '100%' }}>
                  {columns.map((c, colIdx) => {
                    const isNew = c.isNew;
                    const v = c.values[m.key];
                    if (isNew) {
                      return (
                        <InputCellV2 key={colIdx} metric={m} value={v ?? ''}
                                     active={activeCell === m.key}
                                     onFocus={() => setActiveCell(m.key)}
                                     onBlur={() => setActiveCell(null)}
                                     onChange={val => updateDraftValue(m.key, val)}
                                     previous={latest}/>
                      );
                    }
                    return <ValueCellV2 key={colIdx} metric={m} value={v}
                                        isMostRecent={colIdx === columns.length - 1}/>;
                  })}
                  <div style={{ flex: '1 0 0', minWidth: 0 }}/>
                </div>
              </div>

              {/* Sticky trend */}
              <div style={{
                width: V2_COL.trend, flexShrink: 0,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 3, padding: '6px 4px',
                borderLeft: '1px solid var(--ink-100)',
              }}>
                <Sparkline metric={m} width={54} height={18} fill={false}/>
                <span style={{
                  width: 16, height: 2.5, borderRadius: 2,
                  background: latest != null ? STATUS_COLOR[latestStatus].fg : 'var(--ink-200)',
                }}/>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function DateHeaderCell({ batch, setNewBatch, isPinnedRecent }) {
  if (batch.isNew) {
    return (
      <div style={{
        width: V2_COL.value, flexShrink: 0, padding: '6px 4px',
        borderLeft: '2px solid var(--brand)', background: 'var(--brand-tint)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <input type="date" value={batch.date}
               onChange={e => setNewBatch(nb => ({ ...nb, date: e.target.value }))}
               style={{
                 width: '100%', border: 'none', background: 'transparent',
                 color: 'var(--brand)', fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                 textAlign: 'center', outline: 'none', fontFamily: 'inherit',
               }}/>
      </div>
    );
  }
  const d = new Date(batch.date + 'T00:00');
  const day = d.getDate();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  const yr = String(d.getFullYear()).slice(-2);
  return (
    <div style={{
      width: V2_COL.value, flexShrink: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '6px 4px',
      background: isPinnedRecent ? 'var(--ink-50)' : 'transparent',
      borderLeft: isPinnedRecent ? '1px solid var(--ink-200)' : '1px solid var(--ink-100)',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: isPinnedRecent ? 'var(--ink-900)' : 'var(--ink-600, #5b6670)' }}>{day} {mon}</div>
      <div style={{ fontSize: 9, fontWeight: 500, color: 'var(--ink-400)', marginTop: 1 }}>'{yr}</div>
    </div>
  );
}

function ValueCellV2({ metric, value, isMostRecent }) {
  const status = value != null ? statusOf(metric, value) : 'empty';
  return (
    <div style={{
      width: V2_COL.value, flexShrink: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 3, padding: '6px 4px',
      borderLeft: isMostRecent ? '1px solid var(--ink-200)' : '1px solid var(--ink-100)',
      background: isMostRecent ? 'var(--ink-50)' : 'transparent',
    }}>
      {value != null ? (
        <>
          <span className="num" style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)', lineHeight: 1.1 }}>{value}</span>
          <span style={{ width: 14, height: 2.5, borderRadius: 2, background: STATUS_COLOR[status].fg, opacity: 0.85 }}/>
        </>
      ) : (
        <span style={{ color: 'var(--ink-300)', fontSize: 13 }}>—</span>
      )}
    </div>
  );
}

function InputCellV2({ metric, value, active, onFocus, onBlur, onChange, previous }) {
  const parsed = value !== '' ? parseFloat(value) : null;
  const status = parsed != null && !Number.isNaN(parsed) ? statusOf(metric, parsed) : null;
  return (
    <div style={{
      width: V2_COL.value, flexShrink: 0,
      borderLeft: '2px solid var(--brand)',
      background: 'rgba(0,163,139,0.05)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 3, padding: '6px 4px',
    }}>
      <input type="number" inputMode="decimal" value={value}
             onChange={e => onChange(e.target.value)}
             onFocus={onFocus} onBlur={onBlur}
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

const btnPrimaryV2 = {
  background: 'var(--brand)', color: 'white', border: 'none', borderRadius: 8,
  padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
};
const btnGhostV2 = {
  background: 'var(--paper)', color: 'var(--ink-700)', border: '1px solid var(--ink-200)',
  borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
};

// Auto-click "+ New entry" for the entry-state artboard
function V2_TimelineEntering() {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const t = setTimeout(() => {
      const btns = ref.current?.querySelectorAll('button') || [];
      for (const b of btns) {
        if (b.textContent.includes('New entry')) { b.click(); break; }
      }
    }, 80);
    return () => clearTimeout(t);
  }, []);
  return <div ref={ref} style={{ width: '100%', height: '100%' }}><V2_Timeline/></div>;
}

window.V2_Timeline = V2_Timeline;
window.V2_TimelineEntering = V2_TimelineEntering;
