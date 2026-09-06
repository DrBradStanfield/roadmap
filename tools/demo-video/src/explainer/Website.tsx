import React from 'react';
import {AbsoluteFill, interpolate, spring} from 'remotion';
import {T} from '../theme';
import {between, fadeIn} from '../ui';
import record from '../../record.json';

const LABEL: Record<string, [string, string]> = {
  apob: ['ApoB', 'g/L'],
  ldl: ['LDL', 'mmol/L'],
  hdl: ['HDL', 'mmol/L'],
  total_cholesterol: ['Total cholesterol', 'mmol/L'],
  triglycerides: ['Triglycerides', 'mmol/L'],
  lpa: ['Lp(a)', 'nmol/L'],
  hba1c: ['HbA1c', 'mmol/mol'],
  creatinine: ['Creatinine', 'µmol/L'],
  systolic_bp: ['Systolic BP', 'mmHg'],
  diastolic_bp: ['Diastolic BP', 'mmHg'],
  weight: ['Weight', 'kg'],
  waist: ['Waist', 'cm'],
  ferritin: ['Ferritin', 'µg/L'],
  tsh: ['TSH', 'mIU/L'],
  alt: ['ALT', 'U/L'],
};

// The matrix is built from the fictional record.json only: same dates, same metrics.
const cells: {metric: string; date: string; value: number}[] = [
  ...record.measurements.filter((m) => m.status === 'active').map((m) => ({metric: m.metricType, date: m.recordedAt, value: m.value})),
  ...record.labValues.filter((l) => l.status === 'active').map((l) => ({metric: l.metricName, date: l.recordedAt, value: l.value})),
];
const DATES = [...new Set(cells.map((c) => c.date))].sort();
const METRICS = Object.keys(LABEL).filter((k) => cells.some((c) => c.metric === k));
const fmt = (iso: string) => {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, mm] = iso.split('-');
  return `${m[Number(mm) - 1]} ${y}`;
};

/** Beat 6: a stylised, clearly-mock results matrix of the fictional record on the website. */
export const Website: React.FC<{frame: number; from: number; to: number; fps: number}> = ({frame, from, to, fps}) => {
  if (frame < from - 1 || frame > to + 12) return null;
  const f = frame - from;
  const overlayAt = 80;
  const pop = spring({frame: f - overlayAt, fps, config: {damping: 200, mass: 0.7, stiffness: 110}});
  const colW = 150;
  return (
    <AbsoluteFill style={{background: '#e9edec', fontFamily: T.font, opacity: between(frame, from, to + 10, 10)}}>
      {/* browser frame */}
      <div style={{position: 'absolute', left: 120, right: 120, top: 40, bottom: 0, background: '#fff', borderRadius: '18px 18px 0 0', boxShadow: '0 10px 40px rgba(0,0,0,0.10)', overflow: 'hidden'}}>
        <div style={{height: 58, background: '#f3f4f4', borderBottom: '1px solid #e2e5e4', display: 'flex', alignItems: 'center', padding: '0 20px', gap: 8}}>
          {['#fe5f57', '#febc2e', '#28c840'].map((c) => (
            <span key={c} style={{width: 13, height: 13, borderRadius: 99, background: c}} />
          ))}
          <div style={{margin: '0 auto', background: '#fff', border: '1px solid #e2e5e4', borderRadius: 9, padding: '6px 18px', fontSize: 17, color: T.ink2, minWidth: 520, textAlign: 'center'}}>
            drstanfield.com/pages/roadmap
          </div>
        </div>
        <div style={{padding: '28px 44px 0'}}>
          <div style={{display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 18}}>
            <div style={{fontSize: 30, fontWeight: 700, color: T.ink}}>Your results</div>
            <div style={{fontSize: 15, color: T.ink3}}>Illustration of the fictional demo record</div>
          </div>
          <div style={{display: 'grid', gridTemplateColumns: `260px repeat(${DATES.length}, ${colW}px)`, fontSize: 17, borderTop: '1px solid #e6e9e8'}}>
            <div style={{padding: '10px 0', fontSize: 13, color: T.ink3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6}}>Metric</div>
            {DATES.map((d) => (
              <div key={d} style={{padding: '10px 0', fontSize: 13, color: T.ink3, fontWeight: 600, textAlign: 'right'}}>
                {fmt(d)}
              </div>
            ))}
            {METRICS.map((m, i) => {
              const o = fadeIn(f, 8 + i * 3, 8);
              return (
                <React.Fragment key={m}>
                  <div style={{padding: '9px 0', borderTop: '1px solid #eef0ef', color: T.ink, opacity: o}}>
                    {LABEL[m][0]} <span style={{color: T.ink3, fontSize: 13}}>{LABEL[m][1]}</span>
                  </div>
                  {DATES.map((d) => {
                    const c = cells.find((x) => x.metric === m && x.date === d);
                    return (
                      <div key={d} style={{padding: '9px 0', borderTop: '1px solid #eef0ef', textAlign: 'right', opacity: o, color: c ? T.ink : '#c8cdcc', fontVariantNumeric: 'tabular-nums', background: c && d === DATES[DATES.length - 2] ? '#e6f4f0' : 'transparent'}}>
                        {c ? c.value : '·'}
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
      {/* overlay */}
      <div style={{position: 'absolute', inset: 0, background: `rgba(23,36,34,${0.55 * pop})`}} />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 380,
          textAlign: 'center',
          color: '#fff',
          fontSize: 78,
          fontWeight: 700,
          letterSpacing: -1,
          opacity: pop,
          transform: `translateY(${interpolate(pop, [0, 1], [24, 0])}px)`,
          textShadow: '0 4px 30px rgba(0,0,0,0.35)',
        }}
      >
        Same file. Same record.
      </div>
    </AbsoluteFill>
  );
};
