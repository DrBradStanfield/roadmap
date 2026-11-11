/**
 * Change 11 (docs/drafts/screening-words-2026-11-12.md), US-06 AC3: new
 * screening types must round-trip. Today's engine is the older engine an
 * un-updated iPhone runs. These tests pin that it keeps a screening value it
 * does not know, and that value's field stamp, when it loads, edits and
 * merges a record a newer device wrote. If one fails, the change that adds
 * that value must wait for an iPhone engine release.
 *
 * What is proven: the stored file keeps the value and its stamp through
 * migrateFile, health-core's own writes and mergeFiles. The edits in case 2
 * are the ones both apps' forms make once those questions show: the form's
 * `screeningWrites` over the plan's derived screenings, each write applied
 * with `setScreening` (the web form via InputPanel.tsx writeScreening and
 * RoadmapStore.setScreening; the iPhone's edit path at
 * ios/engine/my-data-forms.ts:311-312 calls the same pair). For an unknown
 * method neither form shows the date or result: both draw from screeningForm
 * (input-form.ts:430-432), which shows the method question blank, and the
 * iPhone also refuses an unshown field (offered(), my-data-forms.ts:307-308).
 * So for the method probes case 2 shows the store is safe if such a write
 * arrives anyway; for the DEXA and dental probes the DEXA date and result
 * edits are reachable on both apps. Picking a method replaces the value,
 * which is the person's own act (pinned below).
 *
 * Today's clears never remove an unknown value, for two reasons: a clear
 * touches only answers that read non-empty after castEnum (input-form.ts:506),
 * which is why lungScreening 'stopped' survives; and no clear list names a
 * key the engine does not know (input-form.ts:511-512), which is why
 * dexaNextDue survives. Pinned below. The newer engine must add each new key
 * to its own clear lists and ignore a new field when its parent answer no
 * longer supports it (for example dexaNextDue only while dexaScreening is
 * 'dexa_scan' with a date).
 */
import { describe, it, expect } from 'vitest';
import { mergeFiles } from './merge';
import { migrateFile } from './migrate';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';
import { screeningForm, screeningWrites } from './input-form';
import { setScreening } from './state-edits';
import { computePlan, derivePlanInputs } from './plan';

const T_BASE = '2026-01-01T00:00:00Z';
const T_NEWER = '2026-11-01T09:00:00Z';
const T_EDIT = '2026-11-02T10:00:00Z';
/** Before T_NEWER: an edit this device made before it saw the newer device's value. */
const T_STALE = '2026-10-01T08:00:00Z';
const OPTS = { deviceId: 'dev_older', now: '2026-11-03T12:00:00Z' };
const stamp = (lamport: number, updatedAt: string) => ({ lamport, updatedAt });

type Probe = {
  name: string;
  /** The camelCase field a newer engine would store, and the value it writes. */
  values: Record<string, string>;
  /** Another answer of the same screening, changed on today's engine (snake_case keys, as the form sends them). */
  edits: Array<[string, string]>;
};

const PROBES: Probe[] = [
  { name: "cervicalMethod 'cotest_every_5yr'", values: { cervicalMethod: 'cotest_every_5yr' },
    edits: [['cervical_last_date', '2025-03'], ['cervical_result', 'normal']] },
  { name: "cervicalMethod 'stopped'", values: { cervicalMethod: 'stopped' },
    edits: [['cervical_last_date', '2025-03'], ['cervical_result', 'normal']] },
  { name: "cervicalMethod 'hpv_self_every_3yr'", values: { cervicalMethod: 'hpv_self_every_3yr' },
    edits: [['cervical_last_date', '2025-03'], ['cervical_result', 'normal']] },
  { name: "colorectalMethod 'stopped'", values: { colorectalMethod: 'stopped' },
    edits: [['colorectal_last_date', '2025-03'], ['colorectal_result', 'normal']] },
  { name: "lungScreening 'stopped'", values: { lungScreening: 'stopped' },
    edits: [['lung_last_date', '2025-03'], ['lung_result', 'normal']] },
  { name: "unknown key dexaNextDue '2028-04'", values: { dexaNextDue: '2028-04' },
    edits: [['dexa_last_date', '2025-03'], ['dexa_result', 'normal']] },
  // Dental fields live in file.screenings (merged field by field), so this probe
  // covers them; a top-level file key would not be covered by this test.
  // No dental screening exists today, so the edit is to another screening's answers.
  { name: "unknown key dentalInterval '6'", values: { dentalInterval: '6' },
    edits: [['dexa_last_date', '2025-03'], ['dexa_result', 'normal']] },
];

/** A record as a newer device wrote it: known answers stamped at T_BASE, the probe stamped later. */
function newerDeviceFile(probe: Probe): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'dev_newer', now: T_BASE });
  file.profile = { sex: 'female', birthYear: 1964, heightCm: 165, updatedAt: T_BASE, lamport: 1,
    fieldStamps: { sex: stamp(1, T_BASE), birthYear: stamp(1, T_BASE), heightCm: stamp(1, T_BASE) } };
  const known = { dexaScreening: 'dexa_scan', lungSmokingHistory: 'former_smoker', lungPackYears: 30 };
  const fieldStamps: Record<string, { lamport: number; updatedAt: string }> = {};
  for (const field of Object.keys(known)) fieldStamps[field] = stamp(1, T_BASE);
  for (const field of Object.keys(probe.values)) fieldStamps[field] = stamp(2, T_NEWER);
  file.screenings = { ...known, ...probe.values, updatedAt: T_NEWER, lamport: 2, fieldStamps } as RoadmapFile['screenings'];
  // The newer device's save moves the file's own stamp too (migrateFile clamps field stamps to it).
  file.meta = { ...file.meta, updatedAt: T_NEWER, lamport: file.meta.lamport + 1 };
  return file;
}

/** Today's engine changes other answers the way both apps do. */
function editOnTodaysEngine(file: RoadmapFile, edits: Array<[string, string]>, at = T_EDIT): RoadmapFile {
  return edits.reduce((current, [key, value]) => {
    const writes = screeningWrites(derivePlanInputs(current).screenings, key, value);
    return writes.reduce((next, [k, v]) => setScreening(next, k, v, at), current);
  }, file);
}

function expectProbeKept(file: RoadmapFile, probe: Probe) {
  const screenings = file.screenings as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(probe.values)) {
    expect(screenings[field], field).toBe(value);
    expect(file.screenings.fieldStamps?.[field], `${field} stamp`).toEqual(stamp(2, T_NEWER));
  }
}

describe('US-06 AC3, Change 11: an older engine keeps a screening value it does not know', () => {
  describe.each(PROBES)('$name', (probe) => {
    const remote = newerDeviceFile(probe);
    const loaded = migrateFile(JSON.parse(JSON.stringify(remote)), OPTS);
    const edited = editOnTodaysEngine(loaded, probe.edits);

    it('1. migrateFile keeps the value and its stamp', () => {
      expectProbeKept(loaded, probe);
    });

    it('2. editing another answer of the same screening keeps the value and its stamp', () => {
      // The edits themselves landed, so the path really ran.
      const screenings = edited.screenings as unknown as Record<string, unknown>;
      for (const [key, value] of probe.edits) {
        const field = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        expect(screenings[field], field).toBe(value);
      }
      expectProbeKept(edited, probe);
    });

    it('3. mergeFiles both ways keeps the value and its stamp', () => {
      // Both copies hold the probe here, so this only checks merge does not drop it; 3b is the real merge test.
      for (const merged of [mergeFiles(edited, remote, OPTS), mergeFiles(remote, edited, OPTS)]) {
        expectProbeKept(merged, probe);
      }
    });

    // The stale copy never holds the probe key, so this checks merge keeps a field the other side lacks,
    // whatever the timestamps; it is not a stale-versus-newer test on one field.
    it('3b. an edit made before this device saw the value does not overwrite it in the merge', () => {
      const before = createEmptyFile({ deviceId: 'dev_older', now: T_BASE });
      before.profile = remote.profile;
      const staleEdit = editOnTodaysEngine(before, probe.edits, T_STALE);
      expect(staleEdit.meta.updatedAt < T_NEWER).toBe(true);
      for (const merged of [mergeFiles(staleEdit, remote, OPTS), mergeFiles(remote, staleEdit, OPTS)]) {
        expectProbeKept(merged, probe);
      }
    });

    it("4. today's plan on the file does not throw", () => {
      for (const file of [loaded, edited, mergeFiles(edited, remote, OPTS)]) {
        expect(() => computePlan(file, new Date(OPTS.now))).not.toThrow();
      }
    });
  });
  describe("today's form: a clear does not touch an unknown value; a new method replaces it", () => {
    const load = (values: Record<string, string>) =>
      migrateFile(JSON.parse(JSON.stringify(newerDeviceFile({ name: '', values, edits: [] }))), OPTS);
    const read = (file: RoadmapFile) => file.screenings as unknown as Record<string, unknown>;

    it("dexa 'not_yet_started' clears the date and result but leaves an unknown dexaNextDue", () => {
      const dated = editOnTodaysEngine(load({ dexaNextDue: '2028-04' }), [['dexa_last_date', '2025-03'], ['dexa_result', 'normal']]);
      expect(read(dated).dexaResult).toBe('normal');
      const cleared = editOnTodaysEngine(dated, [['dexa_screening', 'not_yet_started']]);
      expect(read(cleared).dexaScreening).toBe('not_yet_started');
      expect(read(cleared).dexaLastDate ?? '').toBe('');
      expect(read(cleared).dexaResult ?? '').toBe('');
      expect(read(cleared).dexaNextDue).toBe('2028-04');
    });

    it("lung 'never_smoked' clears pack years but leaves lungScreening 'stopped'", () => {
      const cleared = editOnTodaysEngine(load({ lungScreening: 'stopped' }), [['lung_smoking_history', 'never_smoked']]);
      expect(read(cleared).lungSmokingHistory).toBe('never_smoked');
      expect(read(cleared).lungPackYears ?? null).toBeNull();
      expect(read(cleared).lungScreening).toBe('stopped');
    });
    // colorectalMethod has no sibling clear: only its own answer writes it, and that replaces it (as below).

    it("an unknown cervical method shows no date or result, and picking 'hpv_every_5yr' replaces 'cotest_every_5yr'", () => {
      const loaded = load({ cervicalMethod: 'cotest_every_5yr' });
      const keys = screeningForm(62, 'female', derivePlanInputs(loaded).screenings).flatMap((s) => s.groups)
        .filter((g) => g.id === 'cervical').flatMap((g) => g.fields).map((f) => ('key' in f ? f.key : ''));
      expect(keys).toEqual(['cervical_method']);
      const picked = editOnTodaysEngine(loaded, [['cervical_method', 'hpv_every_5yr']]);
      expect(read(picked).cervicalMethod).toBe('hpv_every_5yr');
      expect(picked.screenings.fieldStamps?.cervicalMethod?.updatedAt).toBe(T_EDIT);
    });
  });
});
