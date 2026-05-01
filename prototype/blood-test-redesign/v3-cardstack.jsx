// V3 — Focused Card Stack. Bold mobile-first reimagining.
// - Home: vertical stack of large metric cards. Each = big value, sparkline, status ring.
// - Tap a card → detail sheet slides up: full history chart + "+ Add reading" inline.
// - Entry is per-metric, with a date per reading. One metric at a time = zero cognitive load.

function V3_CardStack() {
  const [readings, setReadings] = React.useState(() => {
    const map = {};
    METRICS.forEach(m => { map[m.key] = seriesFor(m); });
    return map;
  });
  const [expanded, setExpanded] = React.useState(null);
  const [draft, setDraft] = React.useState({ value: '', date: new Date().toISOString().slice(0,10) });

  const open = key => {
    setExpanded(key);
    setDraft({ value: '', date: new Date().toISOString().slice(0,10) });
  };
  const close = () => setExpanded(null);
  const save = () => {
    const v = parseFloat(draft.value);
    if (Number.isNaN(v)) return;
    setReadings(r => ({
      ...r,
      [expanded]: [...r[expanded], { date: draft.date, v }].sort((a, b) => a.date.localeCompare(b.date))
    }));
    setDraft({ value: '', date: new Date().toISOString().slice(0,10) });
  };

  const expandedMetric = expanded ? METRICS.find(m => m.key === expanded) : null;
  const expandedReadings = expanded ? readings[expanded] : [];
  const latest = expanded ? expandedReadings[expandedReadings.length - 1] : null;

  return (
    <div className="bt-root" style={{ width: '100%', height: '100%', background: 'var(--bg)', overflow: 'hidden', position: 'relative' }}>
      <div className="bt-scroll" style={{ height: '100%', overflow: 'auto', padding: '16px 14px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', margin: '4px 4px 16px' }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: -0.3 }}>Your labs</div>
            <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 2 }}>Tap any card to view history or add a reading</div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {METRICS.map(m => {
            const rs = readings[m.key] || [];
            const last = rs[rs.length - 1];
            const prev = rs[rs.length - 2];
            return (
              <MetricCard key={m.key} metric={m} readings={rs} last={last} prev={prev}
                          onOpen={() => open(m.key)} />
            );
          })}
        </div>
      </div>

      {/* Bottom detail sheet */}
      <Sheet open={!!expanded} onClose={close}>
        {expandedMetric && (
          <DetailSheet metric={expandedMetric} readings={expandedReadings} latest={latest}
                       draft={draft} setDraft={setDraft} onSave={save} onClose={close}/>
        )}
      </Sheet>
    </div>
  );
}

function MetricCard({ metric, readings, last, prev, onOpen }) {
  const status = last ? statusOf(metric, last.v) : 'empty';
  const info = STATUS_COLOR[status];
  const delta = last && prev ? last.v - prev.v : null;
  const isEmpty = !last;
  const improving = metric.higherIsBetter ? (delta > 0) : (delta < 0);

  return (
    <button onClick={onOpen} style={{
      textAlign: 'left', border: '1px solid var(--ink-200)', borderRadius: 'var(--r-lg)',
      background: 'var(--paper)', padding: 14, cursor: 'pointer', position: 'relative',
      boxShadow: 'var(--shadow-1)', transition: 'transform .1s, box-shadow .15s',
      display: 'flex', flexDirection: 'column', gap: 10, minHeight: 140, fontFamily: 'inherit',
    }} onMouseOver={e => e.currentTarget.style.boxShadow = 'var(--shadow-2)'}
       onMouseOut={e => e.currentTarget.style.boxShadow = 'var(--shadow-1)'}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-500)' }}>{metric.name}</div>
        {!isEmpty && (
          <span style={{
            width: 8, height: 8, borderRadius: '50%', background: info.fg,
            boxShadow: `0 0 0 3px ${info.bg}`,
          }}/>
        )}
      </div>

      {isEmpty ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
          <span style={{
            fontSize: 12, color: 'var(--ink-400)', border: '1px dashed var(--ink-200)',
            padding: '6px 10px', borderRadius: 'var(--r-sm)',
          }}>+ Add first reading</span>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span className="num" style={{ fontSize: 28, fontWeight: 700, letterSpacing: -0.8, color: 'var(--ink-900)' }}>{last.v}</span>
            <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>{metric.unit}</span>
            {delta != null && delta !== 0 && (
              <span style={{
                marginLeft: 'auto', fontSize: 11, fontWeight: 600,
                color: improving ? 'var(--ok)' : 'var(--bad)',
              }}>
                {delta > 0 ? '↑' : '↓'} {Math.abs(delta).toFixed(metric.unit === 'mmol/mol' || metric.unit === 'µmol/L' || metric.unit === 'nmol/L' ? 0 : 2)}
              </span>
            )}
          </div>
          <Sparkline metric={metric} width={160} height={30} stroke={info.fg}/>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
              color: info.fg,
            }}>{STATUS_LABEL[status]}</span>
            <span style={{ fontSize: 10, color: 'var(--ink-400)' }}>{formatDate(last.date, { short: true })}</span>
          </div>
        </>
      )}
    </button>
  );
}

function Sheet({ open, onClose, children }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, pointerEvents: open ? 'auto' : 'none',
      background: open ? 'rgba(10,20,30,0.35)' : 'transparent',
      transition: 'background .2s', zIndex: 10,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        transform: open ? 'translateY(0)' : 'translateY(100%)', transition: 'transform .28s cubic-bezier(.2,.8,.3,1)',
        background: 'var(--paper)', borderTopLeftRadius: 20, borderTopRightRadius: 20,
        maxHeight: '90%', overflow: 'auto', boxShadow: 'var(--shadow-pop)',
      }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--ink-200)', margin: '10px auto 0' }}/>
        {children}
      </div>
    </div>
  );
}

function DetailSheet({ metric, readings, latest, draft, setDraft, onSave, onClose }) {
  const status = latest ? statusOf(metric, latest.v) : 'empty';
  const info = STATUS_COLOR[status];
  const canSave = draft.value !== '' && !Number.isNaN(parseFloat(draft.value));
  const [unit, setUnit] = React.useState(metric.unit);
  const unitToggleable = metric.unit !== metric.altUnit;

  return (
    <div style={{ padding: '14px 18px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{metric.name}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 2 }}>{metric.refLabel} {metric.unit}</div>
        </div>
        <button onClick={onClose} style={{
          background: 'transparent', border: 'none', fontSize: 18, color: 'var(--ink-400)', cursor: 'pointer', padding: 4,
        }}>✕</button>
      </div>

      {latest && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 14px', background: info.bg, borderRadius: 'var(--r-md)', marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: info.fg }}>{STATUS_LABEL[status]} · latest</div>
            <div style={{ marginTop: 4 }}>
              <span className="num" style={{ fontSize: 32, fontWeight: 700, letterSpacing: -0.8 }}>{metric.convert(latest.v, unit)}</span>
              <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--ink-500)' }}>{unit} · {formatDate(latest.date)}</span>
            </div>
          </div>
          <RangeGauge metric={metric} value={latest.v} width={80} height={8}/>
        </div>
      )}

      <HistoryChart metric={metric} readings={readings}/>

      <div style={{ marginTop: 18, padding: 14, borderRadius: 'var(--r-md)', border: '1px solid var(--ink-200)', background: 'var(--ink-50)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-700)', marginBottom: 10 }}>Add reading</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 2, position: 'relative' }}>
            <input type="number" inputMode="decimal" placeholder="Value" value={draft.value}
                   onChange={e => setDraft(d => ({ ...d, value: e.target.value }))}
                   onKeyDown={e => e.key === 'Enter' && canSave && onSave()}
                   style={{
                     width: '100%', padding: '10px 52px 10px 12px', fontSize: 15, fontWeight: 600,
                     border: '1px solid var(--ink-200)', borderRadius: 'var(--r-sm)', background: 'var(--paper)',
                     outline: 'none', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums',
                   }}/>
            <button onClick={() => unitToggleable && setUnit(u => u === metric.unit ? metric.altUnit : metric.unit)}
                    style={{
                      position: 'absolute', right: 6, top: 6, bottom: 6, padding: '0 8px',
                      border: '1px solid var(--ink-200)', background: 'var(--paper)', borderRadius: 999,
                      fontSize: 10, fontWeight: 600, color: 'var(--brand)',
                      cursor: unitToggleable ? 'pointer' : 'default',
                    }}>{unit}</button>
          </div>
          <input type="date" value={draft.date} onChange={e => setDraft(d => ({ ...d, date: e.target.value }))}
                 style={{
                   flex: 1, padding: '10px 10px', fontSize: 13, border: '1px solid var(--ink-200)',
                   borderRadius: 'var(--r-sm)', background: 'var(--paper)', outline: 'none', fontFamily: 'inherit',
                 }}/>
          <button onClick={onSave} disabled={!canSave} style={{
            ...btnPrimaryV3, opacity: canSave ? 1 : 0.5, cursor: canSave ? 'pointer' : 'default',
          }}>Save</button>
        </div>
      </div>
    </div>
  );
}

const btnPrimaryV3 = {
  background: 'var(--brand)', color: 'white', border: 'none', borderRadius: 'var(--r-sm)',
  padding: '0 18px', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
};

function HistoryChart({ metric, readings }) {
  if (readings.length < 1) {
    return <div style={{ height: 120, display: 'grid', placeItems: 'center', color: 'var(--ink-400)', fontSize: 12 }}>No history yet</div>;
  }
  const w = 500, h = 140, padY = 18, padX = 20;
  const vals = readings.map(r => r.v);
  const [optLo, optHi] = metric.optimal;
  const [brdLo, brdHi] = metric.borderline;
  const vmin = Math.min(...vals, optLo, brdLo) * 0.92;
  const vmax = Math.max(...vals, optHi, brdHi) * 1.08;
  const range = vmax - vmin || 1;
  const y = v => padY + (h - padY * 2) - ((v - vmin) / range) * (h - padY * 2);
  const x = i => padX + (i / Math.max(readings.length - 1, 1)) * (w - padX * 2);

  const optY1 = y(optLo), optY2 = y(optHi);
  const okTop = Math.min(optY1, optY2), okH = Math.abs(optY2 - optY1);

  const pathD = readings.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(r.v)}`).join(' ');

  return (
    <div style={{ background: 'var(--ink-50)', borderRadius: 'var(--r-md)', padding: '8px 4px' }}>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
        <rect x={padX} y={okTop} width={w - padX*2} height={okH} fill="var(--ok-soft)" opacity="0.7"/>
        <line x1={padX} x2={w-padX} y1={okTop} y2={okTop} stroke="var(--ok)" strokeDasharray="3 3" strokeWidth="0.8" opacity="0.6"/>
        <line x1={padX} x2={w-padX} y1={okTop+okH} y2={okTop+okH} stroke="var(--ok)" strokeDasharray="3 3" strokeWidth="0.8" opacity="0.6"/>
        <path d={pathD} fill="none" stroke="var(--ink-700)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        {readings.map((r, i) => {
          const s = statusOf(metric, r.v);
          return (
            <g key={i}>
              <circle cx={x(i)} cy={y(r.v)} r="5" fill="var(--paper)" stroke={STATUS_COLOR[s].fg} strokeWidth="2"/>
              <text x={x(i)} y={h - 4} textAnchor="middle" fontSize="9" fill="var(--ink-500)" fontFamily="var(--ff-sans)">{formatDate(r.date, {short: true})}</text>
            </g>
          );
        })}
        <text x={w-padX-2} y={okTop-2} textAnchor="end" fontSize="8" fill="var(--ok)" fontWeight="600">OPTIMAL</text>
      </svg>
    </div>
  );
}

window.V3_CardStack = V3_CardStack;
