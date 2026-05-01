// V2 — Timeline Matrix (narrow desktop, ~420–480px wide).
// Layout, left-to-right:
//   [Metric name (sticky-left)] [horizontal-scroll strip: older batches → 2 most recent → always-visible draft column] [Trend (sticky-right)]
// - The whole section is wrapped in a single card (header + matrix together).
// - The draft column is always present at the right end of the scroll strip.
// - Default scroll position is max-right: 2 most recent + draft visible.
// - "Save" commits filled draft values into a new batch; the draft column then resets empty.

// Sized so that at a 460px container (typical InputPanel column on desktop)
// the visible value strip fits exactly 3 full columns — [most_recent-1]
// [most_recent] [DRAFT]. No partial 4th column.
//   name(108) + 3*value(98) + trend(58) = 460px exact.
const V2_COL = {
  name: 108,
  value: 98,
  trend: 58,
  rowMin: 56,
};

function emptyDraft() {
  return { date: new Date().toISOString().slice(0, 10), values: {} };
}

function V2_Timeline() {
  const [batches, setBatches] = React.useState(() =>
    HISTORY.map(h => ({ ...h, values: { ...h.values } }))
  );
  const [draft, setDraft] = React.useState(emptyDraft);
  const [activeCell, setActiveCell] = React.useState(null);
  const [unitMode, setUnitMode] = React.useState('si'); // 'si' | 'alt'

  const toggleUnitMode = () => setUnitMode(u => u === 'si' ? 'alt' : 'si');

  const sorted = React.useMemo(
    () => [...batches].sort((a, b) => a.date.localeCompare(b.date)),
    [batches]
  );
  const columns = React.useMemo(
    () => [...sorted, { ...draft, isNew: true }],
    [sorted, draft]
  );

  const updateDraftValue = (key, v) =>
    setDraft(d => ({ ...d, values: { ...d.values, [key]: v } }));
  const updateDraftDate = (date) => setDraft(d => ({ ...d, date }));

  // Backfill: edit a value into an EXISTING batch (when its cell was previously empty).
  // Stored in SI; the input converts from display unit at edit time.
  const backfillBatchValue = (batchDate, key, siValue) =>
    setBatches(bs => bs.map(b => b.date === batchDate
      ? { ...b, values: { ...b.values, [key]: siValue } }
      : b));

  const filledCount = Object.values(draft.values)
    .filter(v => v !== '' && v != null).length;

  const saveDraft = () => {
    if (filledCount === 0) return;
    // Draft values are typed in the current displayUnit. Convert to SI before saving.
    const filled = Object.entries(draft.values)
      .filter(([_, v]) => v !== '' && v != null)
      .map(([k, v]) => {
        const m = METRICS.find(x => x.key === k);
        const typed = parseFloat(v);
        const displayUnit = unitMode === 'si' ? m.unit : m.altUnit;
        const si = m.convertFrom(typed, displayUnit);
        return [k, si];
      });
    setBatches(b => [...b, { date: draft.date, values: Object.fromEntries(filled) }]);
    setDraft(emptyDraft());
    setActiveCell(null);
  };

  return (
    <div className="bt-root" style={{
      width: '100%', height: '100%',
      background: 'var(--paper)', borderRadius: 'var(--r-lg)', border: '1px solid var(--ink-200)',
      boxShadow: 'var(--shadow-1)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--ink-100)',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: -0.2 }}>Blood Test Results</div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button style={btnGhostV2}>Upload your lab results</button>
          <button onClick={saveDraft} disabled={filledCount === 0}
                  style={{ ...btnPrimaryV2, opacity: filledCount === 0 ? 0.5 : 1, cursor: filledCount === 0 ? 'default' : 'pointer' }}>
            Save{filledCount > 0 ? ` (${filledCount})` : ''}
          </button>
        </div>
      </div>

      <Matrix columns={columns} draft={draft} updateDraftDate={updateDraftDate}
              activeCell={activeCell} setActiveCell={setActiveCell}
              updateDraftValue={updateDraftValue}
              backfillBatchValue={backfillBatchValue}
              unitMode={unitMode} toggleUnitMode={toggleUnitMode}/>
    </div>
  );
}

function Matrix({ columns, draft, updateDraftDate, activeCell, setActiveCell,
                  updateDraftValue, backfillBatchValue, unitMode, toggleUnitMode }) {
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
              <DateHeaderCell key={i} batch={c} updateDraftDate={updateDraftDate}
                              isPinnedRecent={!c.isNew && i === columns.length - 2}/>
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

          const displayUnit = unitMode === 'si' ? m.unit : m.altUnit;
          const displayRefLabel = unitMode === 'si' ? m.refLabel : m.refLabelAlt;

          return (
            <div key={m.key} style={{
              display: 'flex', alignItems: 'stretch',
              borderBottom: isLast ? 'none' : '1px solid var(--ink-100)',
              minHeight: V2_COL.rowMin,
            }}>
              {/* Sticky metric name + clickable unit chip */}
              <div style={{
                width: V2_COL.name, flexShrink: 0, padding: '8px 10px',
                display: 'flex', flexDirection: 'column', justifyContent: 'center',
                borderRight: '1px solid var(--ink-100)',
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-900)', lineHeight: 1.2 }}>{m.name}</div>
                <button onClick={toggleUnitMode}
                        title="Click to switch units"
                        style={{
                          alignSelf: 'flex-start', marginTop: 3,
                          background: 'var(--ink-50)', color: 'var(--ink-500)',
                          border: '1px solid var(--ink-200)', borderRadius: 999,
                          padding: '1px 7px', fontSize: 10, fontWeight: 600,
                          cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1.2,
                        }}>{displayUnit}</button>
                <div style={{ fontSize: 9, color: 'var(--ink-400)', marginTop: 3, lineHeight: 1.2 }}>{displayRefLabel}</div>
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
                                     active={activeCell === `draft.${m.key}`}
                                     onFocus={() => setActiveCell(`draft.${m.key}`)}
                                     onBlur={() => setActiveCell(null)}
                                     onChange={val => updateDraftValue(m.key, val)}
                                     displayUnit={displayUnit}/>
                      );
                    }
                    // Existing batch — render a value cell. If empty, allow inline backfill.
                    if (v == null) {
                      return (
                        <BackfillCellV2 key={colIdx} metric={m} batchDate={c.date}
                                        active={activeCell === `${c.date}.${m.key}`}
                                        onFocus={() => setActiveCell(`${c.date}.${m.key}`)}
                                        onBlur={() => setActiveCell(null)}
                                        onCommit={(siValue) => backfillBatchValue(c.date, m.key, siValue)}
                                        displayUnit={displayUnit}/>
                      );
                    }
                    return <ValueCellV2 key={colIdx} metric={m} value={v}
                                        displayUnit={displayUnit}
                                        isMostRecent={colIdx === columns.length - 2}/>;
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

function DateHeaderCell({ batch, updateDraftDate, isPinnedRecent }) {
  const dateInputRef = React.useRef(null);
  const formatHeaderDate = (iso) => {
    const d = new Date(iso + 'T00:00');
    const day = d.getDate();
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    const yr = String(d.getFullYear()).slice(-2);
    return { day, mon, yr };
  };

  if (batch.isNew) {
    const { day, mon, yr } = formatHeaderDate(batch.date);
    const openPicker = () => {
      try { dateInputRef.current?.showPicker?.(); }
      catch { dateInputRef.current?.click(); }
    };
    return (
      <button onClick={openPicker}
              title="Click to change date"
              style={{
                width: V2_COL.value, flexShrink: 0, padding: '6px 4px',
                borderLeft: '2px solid var(--brand)', background: 'var(--brand-tint)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
                cursor: 'pointer', border: 'none', borderLeftWidth: 2, fontFamily: 'inherit',
                position: 'relative',
              }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--brand)' }}>{day} {mon}</span>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
            <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="var(--brand)" strokeWidth="1.3"/>
            <line x1="2" y1="6.5" x2="14" y2="6.5" stroke="var(--brand)" strokeWidth="1.3"/>
            <line x1="5" y1="2" x2="5" y2="4.5" stroke="var(--brand)" strokeWidth="1.3" strokeLinecap="round"/>
            <line x1="11" y1="2" x2="11" y2="4.5" stroke="var(--brand)" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </div>
        <div style={{ fontSize: 9, fontWeight: 500, color: 'var(--brand)', opacity: 0.7 }}>'{yr}</div>
        {/* Hidden native date input — opened programmatically by showPicker() */}
        <input ref={dateInputRef} type="date" value={batch.date}
               onChange={e => updateDraftDate(e.target.value)}
               className="bt-date-hidden-icon"
               style={{
                 position: 'absolute', width: 1, height: 1, opacity: 0,
                 pointerEvents: 'none', border: 'none',
               }}/>
      </button>
    );
  }
  const { day, mon, yr } = formatHeaderDate(batch.date);
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

// Read-only value cell. `value` is in SI canonical; converts for display.
function ValueCellV2({ metric, value, displayUnit, isMostRecent }) {
  const status = value != null ? statusOf(metric, value) : 'empty';
  const shown = value != null ? metric.convert(value, displayUnit) : null;
  return (
    <div style={{
      width: V2_COL.value, flexShrink: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 3, padding: '6px 4px',
      borderLeft: isMostRecent ? '1px solid var(--ink-200)' : '1px solid var(--ink-100)',
      background: isMostRecent ? 'var(--ink-50)' : 'transparent',
    }}>
      <span className="num" style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)', lineHeight: 1.1 }}>{shown}</span>
      <span style={{ width: 14, height: 2.5, borderRadius: 2, background: STATUS_COLOR[status].fg, opacity: 0.85 }}/>
    </div>
  );
}

// Input cell — borderless, matches value cell typography. Column-level
// brand-tint background + brand left-border signals "this is editable".
// Stored in SI; user-typed value is converted from displayUnit on commit.
function InputCellV2({ metric, value, active, onFocus, onBlur, onChange, displayUnit }) {
  // value is whatever the user has typed (in displayUnit). For status preview
  // we convert to SI before threshold lookup.
  const typed = value !== '' ? parseFloat(value) : null;
  const siValue = typed != null && !Number.isNaN(typed)
    ? metric.convertFrom(typed, displayUnit) : null;
  const status = siValue != null ? statusOf(metric, siValue) : null;
  return (
    <div style={{
      width: V2_COL.value, flexShrink: 0,
      borderLeft: '2px solid var(--brand)',
      background: 'var(--brand-tint)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 4, padding: '6px 4px',
    }}>
      <input type="number" inputMode="decimal" value={value}
             onChange={e => onChange(e.target.value)}
             onFocus={onFocus} onBlur={onBlur}
             placeholder="—"
             style={{
               width: '90%', border: 'none', background: 'transparent',
               borderBottom: active ? '1.5px solid var(--brand)' : '1px solid transparent',
               padding: '2px 0', fontSize: 14, fontWeight: 600, color: 'var(--ink-900)',
               textAlign: 'center', outline: 'none',
               fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums',
             }}/>
      <span style={{
        width: 14, height: 2.5, borderRadius: 2,
        background: status ? STATUS_COLOR[status].fg : 'transparent',
      }}/>
    </div>
  );
}

// Backfill cell — empty cell in an existing batch column. Lets the user
// click and type to add a value to that batch. Auto-saves on blur.
function BackfillCellV2({ metric, batchDate, active, onFocus, onBlur, onCommit, displayUnit }) {
  const [draft, setDraft] = React.useState('');
  const handleBlur = () => {
    const typed = draft !== '' ? parseFloat(draft) : null;
    if (typed != null && !Number.isNaN(typed)) {
      const si = metric.convertFrom(typed, displayUnit);
      onCommit(si);
    }
    setDraft('');
    onBlur();
  };
  return (
    <div style={{
      width: V2_COL.value, flexShrink: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 3, padding: '6px 4px',
      borderLeft: '1px solid var(--ink-100)',
    }}>
      <input type="number" inputMode="decimal" value={draft}
             onChange={e => setDraft(e.target.value)}
             onFocus={onFocus} onBlur={handleBlur}
             placeholder="—"
             style={{
               width: '90%', border: 'none', background: 'transparent',
               borderBottom: active ? '1.5px solid var(--brand)' : '1px solid transparent',
               padding: '2px 0', fontSize: 14, fontWeight: 600,
               color: draft ? 'var(--ink-900)' : 'var(--ink-300)',
               textAlign: 'center', outline: 'none',
               fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums',
               cursor: 'text',
             }}/>
      <span style={{ width: 14, height: 2.5, borderRadius: 2, background: 'transparent' }}/>
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

// Entry mode is now the default state (draft column always visible),
// so this is effectively the same as V2_Timeline. Kept as an alias so
// existing artboards in Blood Test Entry.html keep working.
const V2_TimelineEntering = V2_Timeline;

window.V2_Timeline = V2_Timeline;
window.V2_TimelineEntering = V2_TimelineEntering;
