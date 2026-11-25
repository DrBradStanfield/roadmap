// The vitals matrix's blood-pressure cell (StartingInfoVitals).

import { useId, useRef } from 'react';
import type { GradeStatus } from '@roadmap/health-core/row-grade';
import { describedBy } from '../lib/aria';
import { useBpPair } from '../lib/useBpPair';
import { ACTIVE_CELL } from './NumericInputCell';

// ── BP input cell — dual sys/dia input in one column ─────────────────────
// ONE guarded BP input shared by the draft column (today's reading) AND the
// historical backfill cells (a past empty BP slot). Both commit only a
// complete in-range pair (`bpPairReady`, applied by the caller's save fold);
// moving systolic → diastolic never saves, because nothing inside the matrix
// does. `backfill`/`pinned` only swap the wrapper classes so it matches the
// surrounding empty-cell vs draft-cell styling.

export function BpInputCell({
  sys, dia, clash, previewStatus, onSysChange, onDiaChange, onEnter, pinned, backfill, active,
}: {
  sys: string;
  dia: string;
  /** Why the pair cannot be saved as it stands (`SAME_SLOT`). */
  clash?: string;
  previewStatus: GradeStatus;
  onSysChange: (v: string) => void;
  onDiaChange: (v: string) => void;
  onEnter: () => void;
  /** 2nd-from-right column highlight (matches BatchDateCell pinning). */
  pinned?: boolean;
  /** Style as an empty-slot backfill cell rather than the draft column. */
  backfill?: boolean;
  /** Brand-underline highlight (the same `bt-input-active` cue a focused cell
   *  gets) — used so a chatbot prefill flashes the filled BP cell. */
  active?: boolean;
}) {
  const cellRef = useRef<HTMLDivElement>(null);
  // The pair's typing rules, shared with the blood pressure widget (US-75 AC2).
  const { diaRef, onKey, settle, handleSysChange, handleDiaChange, pairError, sysError, diaError } = useBpPair({ sys, dia, clash, onSysChange, onDiaChange, onEnter });
  const error = sysError ?? diaError;
  // Each half's visible error describes it; a title would be captured with
  // the page (US-13 AC10). One error for the pair (a clash) shows once, and
  // when it falls to the diastolic line it describes both halves.
  const id = useId();
  const [sysErrorId, diaErrorId] = [`${id}sys`, `${id}dia`];
  const diaOwnError = diaError && diaError !== sysError;
  // `bt-cell-value` carries the fixed column width (flex: 0 0 var(--bt-value-w)).
  // The backfill branch was missing it, so an empty BP slot collapsed to its
  // content width (~33px) and pushed every column to its right out of
  // alignment with the weight/waist rows. The draft branch already had it.
  const wrapperClass = backfill
    ? `bt-cell-value bt-cell-backfill${pinned ? ' bt-cell-pinned' : ''}`
    : 'bt-cell-value bt-cell-input bt-cell-draft';
  // The two BP inputs are ~35px wide inside a 91px mobile column — near-misses
  // land on cell padding, the "/" separator, or the tick footer, all inert
  // (dead-click cluster, 2026-08 audit / US-02). Route any click on those
  // non-input parts to the systolic input; clicks ON an input are untouched
  // (so aiming at diastolic still works).
  const focusSysFromShell: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    cellRef.current?.querySelector('input')?.focus();
  };
  return (
    <div ref={cellRef} className={wrapperClass} onClick={focusSysFromShell}>
      <div className="bt-vitals-bp-inputs">
        <input className={`bt-input${active ? ` ${ACTIVE_CELL}` : ''}${sysError ? ' bt-input-error' : ''}`}
               inputMode="numeric" pattern="[0-9]*" placeholder="sys" size={1} aria-label="Systolic blood pressure"
               aria-invalid={!!sysError} aria-describedby={describedBy(sysError && sysErrorId, diaOwnError && diaError === pairError && diaErrorId)}
               value={sys} onChange={e => handleSysChange(e.target.value)} onKeyDown={onKey} onBlur={settle}/>
        <span className="bt-vitals-bp-sep">/</span>
        <input ref={diaRef} className={`bt-input${active ? ` ${ACTIVE_CELL}` : ''}${diaError ? ' bt-input-error' : ''}`}
               inputMode="numeric" pattern="[0-9]*" placeholder="dia" size={1} aria-label="Diastolic blood pressure"
               aria-invalid={!!diaError} aria-describedby={describedBy(diaError && (diaOwnError ? diaErrorId : sysErrorId))}
               value={dia} onChange={e => handleDiaChange(e.target.value)} onKeyDown={onKey} onBlur={settle}/>
      </div>
      <div className="bt-cell-foot">
        {sysError && <span id={sysErrorId} className="bt-input-error-text">{sysError}</span>}
        {diaOwnError && <span id={diaErrorId} className="bt-input-error-text">{diaError}</span>}
        {!error && <span className={`bt-status-tick bt-status-${previewStatus ?? 'none'}`}/>}
      </div>
    </div>
  );
}
