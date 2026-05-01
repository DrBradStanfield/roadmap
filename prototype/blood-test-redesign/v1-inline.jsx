// V1 — Inline Edit. Conservative evolution of current UI.
// - List of metrics, always visible.
// - Tap a row's value area to enter edit mode for that row only.
// - Small sparkline + status pill in every row.
// - Date picker hovers at top when any row is being edited.
// - Per-row Save (✓) or Cancel.
// - Unit toggle pill per field.

function V1_InlineEdit() {
  const [rows, setRows] = React.useState(() =>
    METRICS.map(m => {
      const pts = seriesFor(m);
      const last = pts[pts.length - 1];
      return { key: m.key, lastValue: last?.v, lastDate: last?.date, unit: m.unit, draft: '', editing: false };
    })
  );
  const [batchDate, setBatchDate] = React.useState('2026-04-22');
  const [savedPulse, setSavedPulse] = React.useState(null);

  const anyEditing = rows.some(r => r.editing);

  const setRow = (key, patch) => setRows(rs => rs.map(r => r.key === key ? { ...r, ...patch } : r));

  const startEdit = key => setRow(key, { editing: true, draft: '' });
  const cancelEdit = key => setRow(key, { editing: false, draft: '' });
  const saveEdit = key => {
    setRows(rs => rs.map(r => {
      if (r.key !== key) return r;
      const n = parseFloat(r.draft);
      if (Number.isNaN(n)) return { ...r, editing: false, draft: '' };
      return { ...r, lastValue: n, lastDate: batchDate, editing: false, draft: '' };
    }));
    setSavedPulse(key);
    setTimeout(() => setSavedPulse(null), 1400);
  };

  const toggleUnit = key => setRows(rs => rs.map(r => {
    if (r.key !== key) return r;
    const m = METRICS.find(x => x.key === key);
    const newUnit = r.unit === m.unit ? m.altUnit : m.unit;
    return { ...r, unit: newUnit };
  }));

  return (
    <div className="bt-root" style={{ width: '100%', height: '100%', background: 'var(--bg)', padding: 16, overflow: 'auto' }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <Header />
        <div style={{
          position: 'sticky', top: 0, zIndex: 5,
          background: anyEditing ? 'var(--paper)' : 'transparent',
          borderRadius: 'var(--r-md)', border: anyEditing ? '1px solid var(--ink-200)' : '1px solid transparent',
          padding: anyEditing ? 12 : 0, marginBottom: 12,
          transition: 'all .18s ease', boxShadow: anyEditing ? 'var(--shadow-1)' : 'none',
          maxHeight: anyEditing ? 80 : 0, overflow: 'hidden',
        }}>
          {anyEditing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--ink-500)', fontWeight: 500 }}>Test date</span>
              <input type="date" value={batchDate} onChange={e => setBatchDate(e.target.value)}
                style={{ flex: 1, border: '1px solid var(--ink-200)', borderRadius: 'var(--r-sm)', padding: '6px 10px', fontSize: 13 }}/>
              <span style={{ fontSize: 11, color: 'var(--ink-400)' }}>applies to all edits below</span>
            </div>
          )}
        </div>

        <div style={{
          background: 'var(--paper)', borderRadius: 'var(--r-lg)', border: '1px solid var(--ink-200)',
          boxShadow: 'var(--shadow-1)', overflow: 'hidden',
        }}>
          {rows.map((r, i) => {
            const m = METRICS.find(x => x.key === r.key);
            const displayVal = r.lastValue != null ? m.convert(r.lastValue, r.unit) : null;
            const status = statusOf(m, r.lastValue);
            return (
              <Row key={r.key} metric={m} row={r} displayVal={displayVal} status={status}
                   isFirst={i === 0} isLast={i === rows.length - 1} justSaved={savedPulse === r.key}
                   onStart={() => startEdit(r.key)} onCancel={() => cancelEdit(r.key)}
                   onSave={() => saveEdit(r.key)}
                   onChange={v => setRow(r.key, { draft: v })}
                   onToggleUnit={() => toggleUnit(r.key)} />
            );
          })}
        </div>

        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--ink-400)', textAlign: 'center' }}>
          Tap any value to edit · Unit pill to switch · Sparkline shows last 4 readings
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 14, padding: '4px 2px' }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--ink-900)', letterSpacing: -0.2 }}>Blood Test Results</div>
        <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 2 }}>5 batches · Last updated 1 Apr 2026</div>
      </div>
      <button style={{
        background: 'var(--brand)', color: 'white', border: 'none', borderRadius: 'var(--r-md)',
        padding: '8px 14px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
      }}>Upload records</button>
    </div>
  );
}

function Row({ metric, row, displayVal, status, isFirst, isLast, justSaved, onStart, onCancel, onSave, onChange, onToggleUnit }) {
  const inputRef = React.useRef(null);
  React.useEffect(() => { if (row.editing) inputRef.current?.focus(); }, [row.editing]);

  const unitClickable = metric.unit !== metric.altUnit;
  const statusInfo = STATUS_COLOR[status];

  return (
    <div style={{
      borderTop: isFirst ? 'none' : '1px solid var(--ink-100)',
      padding: '14px 16px',
      background: justSaved ? 'var(--ok-soft)' : row.editing ? 'var(--brand-tint)' : 'transparent',
      transition: 'background .3s ease',
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Metric name + reference */}
        <div style={{ flex: '0 0 140px', minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)' }}>{metric.name}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-400)', marginTop: 2 }}>{metric.refLabel}</div>
        </div>

        {/* Value / input */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {row.editing ? (
            <input ref={inputRef} type="number" inputMode="decimal" value={row.draft}
                   onChange={e => onChange(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }}
                   placeholder={row.lastValue != null ? `Previous: ${metric.convert(row.lastValue, row.unit)}` : 'Enter value'}
                   style={{
                     flex: 1, minWidth: 0, border: '1.5px solid var(--brand)', background: 'var(--paper)',
                     borderRadius: 'var(--r-sm)', padding: '6px 10px', fontSize: 16, fontWeight: 600,
                     fontVariantNumeric: 'tabular-nums', outline: 'none',
                   }}/>
          ) : displayVal != null ? (
            <button onClick={onStart} style={{
              flex: '0 0 auto', padding: '4px 8px', borderRadius: 'var(--r-sm)', border: 'none',
              background: 'transparent', cursor: 'pointer', textAlign: 'left',
              fontSize: 18, fontWeight: 600, color: 'var(--ink-900)', fontVariantNumeric: 'tabular-nums',
            }}>{displayVal}</button>
          ) : (
            <button onClick={onStart} style={{
              flex: '0 0 auto', padding: '4px 8px', borderRadius: 'var(--r-sm)', border: '1px dashed var(--ink-200)',
              background: 'transparent', cursor: 'pointer',
              fontSize: 12, color: 'var(--ink-400)', fontWeight: 500,
            }}>+ Add</button>
          )}

          <button onClick={onToggleUnit} style={{
            border: '1px solid var(--ink-200)', background: unitClickable ? 'var(--paper)' : 'transparent',
            color: 'var(--brand)', borderRadius: 999, padding: '2px 8px', fontSize: 11, fontWeight: 500,
            cursor: unitClickable ? 'pointer' : 'default', whiteSpace: 'nowrap',
          }}>{row.unit}</button>

          {!row.editing && displayVal != null && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Sparkline metric={metric} width={64} height={22}/>
              <span style={{
                fontSize: 10, fontWeight: 600, color: statusInfo.fg, background: statusInfo.bg,
                padding: '2px 7px', borderRadius: 999, letterSpacing: 0.2, textTransform: 'uppercase',
              }}>{STATUS_LABEL[status]}</span>
            </div>
          )}
        </div>

        {/* Actions */}
        {row.editing && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={onSave} style={{
              background: 'var(--brand)', color: 'white', border: 'none', borderRadius: 'var(--r-sm)',
              width: 32, height: 32, cursor: 'pointer', display: 'grid', placeItems: 'center',
            }}>
              <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7.5l3 3 5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
            </button>
            <button onClick={onCancel} style={{
              background: 'var(--paper)', color: 'var(--ink-500)', border: '1px solid var(--ink-200)', borderRadius: 'var(--r-sm)',
              width: 32, height: 32, cursor: 'pointer',
            }}>✕</button>
          </div>
        )}
      </div>

      {row.lastValue != null && !row.editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, paddingLeft: 152, fontSize: 11, color: 'var(--ink-400)' }}>
          <span>Recorded {formatDate(row.lastDate)}</span>
        </div>
      )}
    </div>
  );
}

window.V1_InlineEdit = V1_InlineEdit;
