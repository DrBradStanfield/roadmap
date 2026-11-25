// One blood pressure pair's typing rules (US-02 AC4-AC9), shared by the vitals
// grid's cell (BpInputCell) and the blood pressure widget (US-75 AC2): digits
// only, each half's range by the grid's own reading, a range error held back
// while more digits could fix it, a pair the wrong way up as the pair's error,
// and the systolic -> diastolic auto-advance. Each caller draws its own boxes.
import { useRef } from 'react';
import { parseLocalisedNumber } from '@roadmap/health-core/parseNumber';
import { PRESSURE_ORDER, pressureInverted } from '@roadmap/health-core/validation';
import { blockNonIntegerKeys, bpDiaAdvance, bpSysAdvance, mayStillFit, validateTypedValue } from './blood-test-cell';
import { useAutoAdvance } from './useAutoAdvance';
import { useRangeWait } from './useRangeWait';

export function useBpPair({ sys, dia, clash, onSysChange, onDiaChange, onEnter, next }: {
  sys: string;
  dia: string;
  /** Why the pair cannot be saved as it stands (`SAME_SLOT`). */
  clash?: string;
  onSysChange: (v: string) => void;
  onDiaChange: (v: string) => void;
  onEnter: () => void;
  /** The box after the diastolic, when a complete diastolic moves on to it (US-75 AC2); only while it is empty. */
  next?: () => HTMLInputElement | null;
}) {
  const diaRef = useRef<HTMLInputElement>(null);
  const advanceToDia = useAutoAdvance();
  const advanceToNext = useAutoAdvance();
  // BP is integer-only (US-02 AC4) — block non-digit keystrokes; paste is
  // sanitised in the change handlers below.
  const onKey: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    blockNonIntegerKeys(e);
    if (e.key === 'Enter') { e.preventDefault(); rangeWait.settle(); onEnter(); }
  };
  // US-02 AC9: the half being typed keeps back a range error more digits
  // could still fix ("6" on the way to 65); leaving it or Enter shows it.
  const rangeWait = useRangeWait();
  const check = (half: 'sys' | 'dia', text: string) => validateTypedValue(half === 'sys' ? 'systolic_bp' : 'diastolic_bp', text, 'si');
  const typedHalf = (half: 'sys' | 'dia', text: string) => {
    const { range } = check(half, text);
    rangeWait.typed(half, text, mayStillFit(text, range.min, range.max));
  };
  const rangeError = (half: 'sys' | 'dia', text: string) => {
    const { error } = check(half, text);
    return error && !rangeWait.waits(half, text) ? error : undefined;
  };
  // Auto-advance systolic → diastolic (US-02 AC6): immediately for an
  // unambiguous 3-digit value, after 800ms for a plausible 2-digit one.
  // A pause moves only if systolic has the focus when it ends (AC6b, the hook's rule: leaving
  // and coming back first still moves); never if dia had content when systolic last changed.
  const handleSysChange = (raw: string) => {
    const v = raw.replace(/[^0-9]/g, '');
    typedHalf('sys', v);
    onSysChange(v);
    const adv = bpSysAdvance(v);
    advanceToDia(dia === '' && adv !== 'stay' ? { ambiguous: adv === 'defer', advance: () => diaRef.current?.focus() } : null);
  };
  const handleDiaChange = (raw: string) => {
    const v = raw.replace(/[^0-9]/g, '');
    typedHalf('dia', v);
    onDiaChange(v);
    const box = next?.();
    if (next) advanceToNext(box && box.value === '' && bpDiaAdvance(v) === 'advance' ? { ambiguous: false, advance: () => box.focus() } : null);
  };
  // A pair the wrong way up is the pair's error, as a clash is (US-02 AC8).
  const pairError = clash ?? (pressureInverted(parseLocalisedNumber(sys), parseLocalisedNumber(dia)) ? PRESSURE_ORDER : undefined);
  const sysError = rangeError('sys', sys) ?? pairError;
  const diaError = rangeError('dia', dia) ?? pairError;
  return { diaRef, onKey, settle: rangeWait.settle, handleSysChange, handleDiaChange, pairError, sysError, diaError };
}
