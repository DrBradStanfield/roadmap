// US-21 phase 1 — read-only surfacing of stored `labValues` (tests beyond
// the core 8 matrix), grouped by panel, collapsed by default, icon per
// group. No editing/corrections here (that's a later phase). Expanded groups
// render in the SAME date-column matrix layout as the core blood-test table
// (AC1) — reusing its cells, scroller, and CSS vars.

import { useEffect, useMemo, useState } from 'react';
import { groupLabValues, countLabValuePoints, labGroupMatrix, type LabRowsIcon, type LabValueGroup } from '../lib/lab-rows';
import { AddLabTest } from './AddLabTest';
import { UnitChip } from './UnitChip';
import { BatchDateCell } from './BloodTestTimeline';
import { useScrollToRightOnMount } from '../lib/useScrollToRightOnMount';
import { trackProductEvent } from '../lib/api';
import type { ApiLabValue } from '../lib/api-types';

function formatValue(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function GroupIcon({ icon }: { icon: LabRowsIcon }) {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true } as const;
  switch (icon) {
    case 'kidney':
      return (
        <svg {...common}>
          <path d="M6 2.5C3.5 2.5 2 4.8 2 7.5S3.5 13.5 6 13.5c1.3 0 1.6-1 1.6-2.2 0-1-.6-1.4-.6-2.3 0-1.1 1-1.3 1-2.5 0-1.2-1-1.4-1-2.5C7 3 6.8 2.5 6 2.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
          <path d="M7.6 8h4.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      );
    case 'liver':
      return (
        <svg {...common}>
          <path d="M2 8.5c0-3 2.6-5.5 6.2-5.5 3.6 0 5.8 2.2 5.8 4.6 0 2.8-2.3 4.9-6 4.9-1.4 0-2.2.6-3.4.6C2.9 13.1 2 11.2 2 8.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
        </svg>
      );
    case 'droplet':
      // Two blood cells (the 'hormones' icon is already a droplet).
      return (
        <svg {...common}>
          <circle cx="5.6" cy="6.1" r="2.9" stroke="currentColor" strokeWidth="1.2"/>
          <circle cx="10.6" cy="10" r="2.9" stroke="currentColor" strokeWidth="1.2"/>
          <path d="M4.3 6.1a1.3 1.3 0 0 1 1.3-1.3" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        </svg>
      );
    case 'thyroid':
      return (
        <svg {...common}>
          <path d="M8 5.2C7 3.6 4.8 3 3.4 4c-1.4 1-1.5 3-.2 4 1 .8 2.2.6 3-.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          <path d="M8 5.2c1-1.6 3.2-2.2 4.6-1.2 1.4 1 1.5 3 .2 4-1 .8-2.2.6-3-.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          <path d="M8 5.2v3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      );
    case 'hormones':
      return (
        <svg {...common}>
          <path d="M8 2.5c1.8 2.3 3.2 4.5 3.2 6.3a3.2 3.2 0 1 1-6.4 0c0-1.8 1.4-4 3.2-6.3Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
        </svg>
      );
    case 'vitamins':
      return (
        <svg {...common}>
          <rect x="3" y="6.2" width="10" height="5.6" rx="2.8" stroke="currentColor" strokeWidth="1.2"/>
          <line x1="8" y1="6.2" x2="8" y2="11.8" stroke="currentColor" strokeWidth="1.2"/>
        </svg>
      );
    case 'flame':
      return (
        <svg {...common}>
          <path d="M8 2.8c.3 1.6-1.8 2.6-1.8 4.6a2.3 2.3 0 0 0 4.6.2c.7.9.9 1.9.9 2.6a3.7 3.7 0 0 1-7.4 0C4.3 8 5.3 6.3 5.3 5c0 .9.5 1.4.9 1.4C6.6 4.6 7.6 3.6 8 2.8Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
        </svg>
      );
    case 'flask':
    default:
      return (
        <svg {...common}>
          <path d="M6.3 2.6h3.4M6.8 2.6v3.6L4 11.4a1.4 1.4 0 0 0 1.2 2.1h5.6a1.4 1.4 0 0 0 1.2-2.1L9.2 6.2V2.6" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
          <line x1="5.3" y1="9.2" x2="10.7" y2="9.2" stroke="currentColor" strokeWidth="1.1"/>
        </svg>
      );
  }
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"
         className={`alr-chevron${expanded ? ' alr-chevron--open' : ''}`}>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// The same single-scroller matrix as BloodTestTimeline (rows = tests,
// columns = dates, sticky name cell, newest column pinned), read-only.
function LabGroupMatrix({ group }: { group: LabValueGroup }) {
  const { dates, points } = useMemo(() => labGroupMatrix(group), [group]);
  const scrollRef = useScrollToRightOnMount<HTMLDivElement>([dates.length]);
  return (
    <div className="bt-timeline alr-matrix">
      <div className="bt-timeline-body">
        <div ref={scrollRef} className="bt-timeline-scroll">
          <div className="bt-timeline-scroll-inner" style={{ '--bt-col-count': dates.length } as React.CSSProperties}>
            <div className="bt-row bt-header-row">
              <div className="bt-cell-name bt-cell-header">Metric</div>
              {dates.map((d, i) => <BatchDateCell key={d} date={d} pinned={i === dates.length - 1}/>)}
              <div className="bt-row-filler"/>
            </div>
            {group.series.map((s, idx) => (
              <div key={s.seriesKey} className={`bt-row${idx === group.series.length - 1 ? ' bt-row-last' : ''}`}>
                <div className="bt-cell-name">
                  <div className="bt-name-label">{s.label}</div>
                  <UnitChip label={s.unit} title="Unit as reported on the lab document"/>
                  {s.mixedUnits && <div className="bt-ref-label">Units vary between reports</div>}
                </div>
                {dates.map((d, i) => {
                  const p = points[s.seriesKey]?.[d];
                  const pinned = i === dates.length - 1 ? ' bt-cell-pinned' : '';
                  if (!p) {
                    // The space holds the cell open — theme `div:empty
                    // { display:none }` collapses truly empty cells (gotcha).
                    return <div key={d} className={`bt-cell-value bt-cell-empty${pinned}`}>{' '}</div>;
                  }
                  return (
                    <div key={d} className={`bt-cell-value${pinned}`}>
                      <span className="bt-value-num num">
                        {formatValue(p.value)}
                        {s.mixedUnits && <span className="alr-cell-unit">{p.unit}</span>}
                      </span>
                    </div>
                  );
                })}
                <div className="bt-row-filler"/>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LabGroupSection({ group, expanded, onToggle }: { group: LabValueGroup; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="alr-group">
      <button type="button" className="alr-group-header" aria-expanded={expanded} onClick={onToggle}>
        <span className={`alr-group-icon alr-group-icon--${group.icon}`}><GroupIcon icon={group.icon}/></span>
        <span className="alr-group-label">{group.label}</span>
        <span className="alr-group-count">{group.series.length}</span>
        <ChevronIcon expanded={expanded}/>
      </button>
      {expanded && <LabGroupMatrix group={group}/>}
    </div>
  );
}

export function AdditionalLabRows({ labValues, onAdded }: { labValues: ApiLabValue[]; onAdded?: () => void }) {
  const groups = useMemo(() => groupLabValues(labValues), [labValues]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const totalCount = useMemo(() => countLabValuePoints(groups), [groups]);
  useEffect(() => {
    if (totalCount > 0) trackProductEvent('lab_rows_viewed', { count: totalCount });
  }, [totalCount]);

  // With no data AND no add affordance there is nothing to show. When adding
  // is available (US-21 phase 2) the section renders so a user can record
  // their first test without uploading a report.
  if (groups.length === 0 && !onAdded) return null;

  const toggle = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="alr-wrap">
      <div className="alr-title">Additional lab results</div>
      {groups.map(g => (
        <LabGroupSection key={g.id} group={g} expanded={expandedIds.has(g.id)} onToggle={() => toggle(g.id)}/>
      ))}
      {onAdded && <AddLabTest onAdded={onAdded}/>}
    </div>
  );
}
