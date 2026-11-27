// US-02 AC12: the systolic auto-advance rule lives once, here; the web's boxes and the iPhone's
// sheet (through the engine door bpSysAdvance, ios/engine/bp-advance-door.test.ts) read it. The
// digit cases are pinned in widget-src/src/lib/blood-test-cell.test.ts (US-02 AC6), which reads
// this module.
import { describe, expect, it } from 'vitest';
import { bpSysAdvance } from './bp-advance';

describe('bpSysAdvance with the diastolic (US-02 AC12)', () => {
  it('moves on only while the diastolic is empty', () => {
    expect(bpSysAdvance('120', '')).toBe('advance');
    expect(bpSysAdvance('75', '')).toBe('defer');
    expect(bpSysAdvance('120', '80')).toBe('stay');
    expect(bpSysAdvance('75', '8')).toBe('stay');
  });

  it('reads as before without a diastolic', () => {
    expect(bpSysAdvance('120')).toBe('advance');
    expect(bpSysAdvance('75')).toBe('defer');
    expect(bpSysAdvance('12')).toBe('stay');
  });
});
