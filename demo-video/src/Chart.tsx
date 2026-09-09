import React from 'react';
import {interpolate, Easing} from 'remotion';
import {T} from './theme';

type Pt = {date: string; value: number};

const W = 610;
const H = 232;
const PAD = {l: 46, r: 96, t: 18, b: 34};

const short = (iso: string) => {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, mm] = iso.split('-');
  return `${m[Number(mm) - 1]} ${y.slice(2)}`;
};

export const ApobChart: React.FC<{series: Pt[]; progress: number}> = ({series, progress}) => {
  const times = series.map((p) => new Date(p.date + 'T00:00:00Z').getTime());
  const t0 = times[0];
  const t1 = times[times.length - 1];
  const yMin = 0.4;
  const yMax = 1.4;
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + ((yMax - v) / (yMax - yMin)) * (H - PAD.t - PAD.b);

  const pts = series.map((p, i) => ({...p, x: x(times[i]), y: y(p.value)}));
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  // Draw-on: stroke dash reveal, then markers pop in one by one.
  const draw = interpolate(progress, [0, 0.62], [0, 1], {
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.32, 0, 0.2, 1),
  });
  const len = 900;

  const ticks = [0.5, 0.7, 0.9, 1.1, 1.3];

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{display: 'block'}}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#efefef" strokeWidth={1} />
          <text
            x={PAD.l - 10}
            y={y(v) + 4}
            textAnchor="end"
            fontSize={11.5}
            fill={T.ink3}
            fontFamily={T.font}
          >
            {v.toFixed(1)}
          </text>
        </g>
      ))}

      {/* target reference line from the plan engine: ApoB target <= 0.50 g/L */}
      <line
        x1={PAD.l}
        x2={W - PAD.r}
        y1={y(0.5)}
        y2={y(0.5)}
        stroke={T.amber}
        strokeWidth={1.4}
        strokeDasharray="5 4"
        opacity={interpolate(progress, [0.55, 0.8], [0, 0.85], {extrapolateRight: 'clamp'})}
      />
      <text
        x={W - PAD.r + 6}
        y={y(0.5) + 4}
        fontSize={11.5}
        fill={T.amber}
        fontFamily={T.font}
        opacity={interpolate(progress, [0.6, 0.85], [0, 1], {extrapolateRight: 'clamp'})}
      >
        target ≤0.50
      </text>

      <path
        d={path}
        fill="none"
        stroke={T.accent}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={len}
        strokeDashoffset={len * (1 - draw)}
      />

      {pts.map((p, i) => {
        const start = 0.1 + i * 0.1;
        const o = interpolate(progress, [start, start + 0.12], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const last = i === pts.length - 1;
        return (
          <g key={p.date} opacity={o}>
            <circle cx={p.x} cy={p.y} r={last ? 6 : 4.5} fill={last ? T.accent : '#fff'} stroke={T.accent} strokeWidth={2} />
            <text
              x={p.x}
              y={H - PAD.b + 20}
              textAnchor="middle"
              fontSize={11.5}
              fill={T.ink3}
              fontFamily={T.font}
            >
              {short(p.date)}
            </text>
          </g>
        );
      })}

      {/* selective direct label: latest reading only */}
      <g opacity={interpolate(progress, [0.66, 0.9], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}>
        <text
          x={pts[pts.length - 1].x + 12}
          y={pts[pts.length - 1].y - 8}
          fontSize={14}
          fontWeight={600}
          fill={T.ink}
          fontFamily={T.font}
        >
          0.92
        </text>
      </g>
    </svg>
  );
};
