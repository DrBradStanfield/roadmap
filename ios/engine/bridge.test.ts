// US-25 AC18: the engine side of the native bridge matches its checked-in
// contract (bridge-contract.json). The contract's hash is the bridge id a
// downloaded engine must match, so drift here would let an engine reach an app
// that cannot serve it. The Swift side: EngineBridgeContractTests.swift.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDIT_OUTCOME } from './contract';
import * as entry from './entry';
import { UPLOAD_REFUSAL_REASONS } from './upload-doors';

const contract = JSON.parse(readFileSync(join(__dirname, 'bridge-contract.json'), 'utf8')) as {
  natives: Record<string, string>;
  events: string[];
  values: Record<string, string>;
  doors: Record<string, { args: string[]; returns?: string }>;
};
// Both-way additions that keep the bridge id (D14): never hashed.
const optional = JSON.parse(readFileSync(join(__dirname, 'bridge-optional.json'), 'utf8')) as {
  doors: Record<string, { optionalArgs?: string[]; optionalReturns?: string }>;
  optionalDoors: Record<string, { args: string[]; returns: string }>;
};
const optionalArgs = (name: string) => optional.doors[name]?.optionalArgs ?? [];
const arity = (name: string) => (optional.optionalDoors[name]?.args.length ?? contract.doors[name].args.length + optionalArgs(name).length);

/** A door's parameter names, in order, read from entry.ts's signature. */
function parameters(name: string): string[] {
  const source = readFileSync(join(__dirname, 'entry.ts'), 'utf8');
  const signature = source.match(new RegExp(`export (?:async )?function ${name}\\(([^)]*)\\)`))?.[1];
  if (signature === undefined) throw new Error(`no signature for ${name} in entry.ts`);
  return [...signature.matchAll(/(?:^|,)\s*(\w+)\??\s*:/g)].map((m) => m[1]);
}

/** Contract arguments to call each optional door with (one entry per door in bridge-optional.json). */
const NOW = '2026-10-21T08:00:00.000Z';
/** A saving phone upload holding one read lab report with one value (the save door's freeze). */
const UPLOAD_SAVING = JSON.stringify({ phase: 'saving', platform: 'phone', run: 1, started: NOW, firstRead: NOW, attempt: 1,
  files: [{ id: 'f1', name: 'a.pdf', bytes: 1, hash: 'h-a', pages: { count: 1, truncated: false }, status: { s: 'read', choices: { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} },
    extraction: { classification: 'lab_report', reportDate: '2026-10-01', values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }], additionalValues: [], unrecognized: [], document: null } } }] });
/** An open phone upload holding one file being hashed (shared upload PR 12). */
const UPLOAD_OPEN = JSON.stringify({ phase: 'open', platform: 'phone', run: 1, started: NOW, firstRead: null,
  files: [{ id: 'f1', name: 'a.pdf', bytes: 1, hash: null, pages: null, status: { s: 'hashing' } }] });
const SAMPLE_ARGS: Record<string, unknown[]> = {
  screenJson: [readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8'), NOW, 'phone', '{}'],
  chatEditsJson: [readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8'),
    JSON.stringify([{ kind: 'field', field: 'ldlC', displayValue: 3.4, unitSystem: 'si', date: '2026-10-01' }]), NOW, 'phone', '2026-10-21', '{}'],
  historyJson: [readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8'), 'ldl', NOW, 'phone', '{}'],
  remindersJson: [readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8'), NOW, 'phone'],
};
/** A door's answer with its timing fields (`ms`) left out, which differ call to call. */
const untimed = (text: string) => JSON.stringify(JSON.parse(text, (key, value) => (key === 'ms' ? undefined : value)));

/** The member names of an exported interface, read from the source. */
function members(file: string, name: string): string[] {
  const source = readFileSync(join(__dirname, file), 'utf8');
  const body = source.slice(source.indexOf(`export interface ${name} {`));
  const block = body.slice(0, body.indexOf('\n}\n'));
  return [...block.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]);
}

describe('bridge contract (US-25 AC18)', () => {
  it('every door the engine exports is in the contract or is an optional door, never both, with its arity', () => {
    const doors = Object.entries(entry).filter(([, v]) => typeof v === 'function');
    const listed = [...Object.keys(contract.doors), ...Object.keys(optional.optionalDoors)];
    expect(doors.map(([k]) => k).sort()).toEqual(listed.sort());
    expect(new Set(listed).size, 'a door in both').toBe(listed.length);
    for (const [name, fn] of doors) expect((fn as (...a: unknown[]) => unknown).length, name).toBe(arity(name));
  });

  // 2026-11-05 (orchestrator): an optional door keeps the bridge id. An old app never calls it; a
  // new app reaches it only through optionalCall, whose nil for a missing door is the safety.
  it('an optional door names its arguments in entry.ts, says what it answers, and is nowhere in the contract', () => {
    for (const [name, door] of Object.entries(optional.optionalDoors)) {
      expect(parameters(name), name).toEqual(door.args);
      expect(door.returns, name).toBeTruthy();
      expect(readFileSync(join(__dirname, 'bridge-contract.json'), 'utf8'), name).not.toContain(name);
    }
  });

  // Append-only: a shipped app decodes each optional door's answer. A door or a field may be added
  // here; none is ever renamed, retyped or dropped, and a door's arguments never change.
  // `bytes`: a door answering a Promise of an ArrayBuffer, not JSON. With no cloud open here it
  // rejects; its bytes answer is pinned in cloud.test.ts (US-73 AC12).
  // `words`: a door answering a Promise of one bare word, never JSON (S50b).
  const FROZEN_OPTIONAL_DOORS: Record<string, { args: string[]; call: unknown[]; shape?: unknown; bytes?: true; words?: string[] }> = {
    labSearchJson: { args: ['text'], call: ['ferr'], shape: [{ name: 'string', key: 'string', kind: 'string', units: ['string'] }] },
    bpSysAdvance: { args: ['systolic', 'diastolic'], call: ['120', ''], words: ['advance', 'defer', 'stay'] }, // US-02 AC12
    documentOriginal: { args: ['id'], call: ['doc-1'], bytes: true },
    cloudOnline: { args: [], call: [], shape: {} }, // US-09 AC30: '{}', nothing to read
    // US-13 AC13: one sure LDL on an empty record (no record text), ticked.
    labReviewGroupsJson: {
      args: ['recordJson', 'extractionJson', 'refsJson', 'reportDay', 'nowIso', 'deviceId'],
      call: ['', JSON.stringify({ classification: 'lab_report', reportDate: '2026-10-01', values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }] }),
        '["v0"]', '2026-10-01', NOW, 'phone'],
      shape: { summary: 'string', items: [{ ref: 'string', group: 'string' }], sure: { willSave: 'string', showAll: 'string', hide: 'string' }, saveRefs: ['string'], save: 'string' },
    },
    cloudEraseHeld: { args: [], call: [], words: ['none', 'transient', 'definite', 'unknown', 'expired'] }, // S50b: 'none' with no cloud open
    uploadVerdictsJson: {
      args: ['request'],
      call: [JSON.stringify({ files: [{ name: 'a.pdf', bytes: 1 }], zipMembers: ['a.pdf'] })],
      shape: { limits: { fileBytes: 'number', zipBytes: 'number', zipMembers: 'number', folderBytes: 'number' }, files: ['string'], zipMembers: ['string'] },
    },
    // Shared upload PR 12 (US-52 AC8c): one phone pick of one file, on an empty record.
    uploadStartJson: { args: ['platform'], call: ['phone'], shape: { phase: 'string', platform: 'string', run: 'number' } },
    uploadStepJson: {
      args: ['stateJson', 'eventJson', 'recordJson', 'deviceId'],
      call: [JSON.stringify({ phase: 'choosing', platform: 'phone', run: 0 }), JSON.stringify({ type: 'picked', files: [{ id: 'f1', name: 'a.pdf', bytes: 1, kind: 'file' }], needsConsent: false, now: NOW }), '', 'phone'],
      shape: { state: { phase: 'string', run: 'number', files: [{ id: 'string', name: 'string', status: { s: 'string' } }] }, effects: [{ type: 'string', run: 'number' }] },
    },
    uploadViewJson: {
      args: ['stateJson', 'recordJson', 'nowIso', 'cloudConnected', 'deviceId'],
      call: [UPLOAD_OPEN, '', NOW, true, 'phone'],
      shape: { summary: 'string', files: { row: 'string', rows: [{ fileId: 'string', name: 'string', status: 'string' }] }, save: { label: 'string', enabled: 'boolean' } },
    },
    uploadSavePlanJson: {
      args: ['stateJson', 'recordJson', 'nowIso', 'cloudConnected', 'deviceId'],
      call: [UPLOAD_OPEN, '', NOW, true, 'phone'],
      shape: { counts: { values: 'number', documents: 'number', archived: 'number', originals: 'number' } },
    },
    uploadUsageJson: { args: ['stateJson'], call: [UPLOAD_OPEN], shape: { known: 'number', failedFinal: 'number' } },
    // The one Save (US-52 AC8c): a saving pick of one read lab report, off-cloud, onto an empty record.
    uploadSaveJson: {
      args: ['stateJson', 'recordJson', 'erase', 'nowIso', 'deviceId', 'originalsJson', 'readOriginal'],
      call: [UPLOAD_SAVING, '', '', NOW, 'phone', '{}', () => null],
      shape: { ok: 'boolean', record: 'string', outcome: { values: 'number', documents: 'number', archived: 'number', unstored: 'number' } },
    },
  };
  /** Where `answer` drops or retypes what `frozen` holds: [] when it holds at least the frozen shape. */
  function shapeFaults(frozen: unknown, answer: unknown, at = '$'): string[] {
    // 'string?': a field that is the type or null (an UploadView line that may be absent).
    if (typeof frozen === 'string' && frozen.endsWith('?')) return answer === null ? [] : shapeFaults(frozen.slice(0, -1), answer, at);
    if (typeof frozen === 'string') return typeof answer === frozen ? [] : [`${at}: ${typeof answer}, not ${frozen}`];
    if (Array.isArray(frozen)) {
      if (!Array.isArray(answer) || !answer.length) return [`${at}: no array to check`];
      return answer.flatMap((item, i) => shapeFaults(frozen[0], item, `${at}[${i}]`));
    }
    if (typeof answer !== 'object' || answer === null) return [`${at}: not an object`];
    return Object.entries(frozen as Record<string, unknown>).flatMap(([key, inner]) =>
      key in answer ? shapeFaults(inner, (answer as Record<string, unknown>)[key], `${at}.${key}`) : [`${at}.${key}: missing`]);
  }

  it('every optional door is frozen, its arguments as they shipped and its answer holding the frozen shape', async () => {
    expect(Object.keys(optional.optionalDoors).sort()).toEqual(Object.keys(FROZEN_OPTIONAL_DOORS).sort());
    for (const [name, frozen] of Object.entries(FROZEN_OPTIONAL_DOORS)) {
      expect(optional.optionalDoors[name].args, name).toEqual(frozen.args);
      const door = (entry as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
      if (frozen.bytes) await expect(door(...frozen.call), name).rejects.toThrow('not open');
      else if (frozen.words) expect(frozen.words, name).toContain(await door(...frozen.call));
      else expect(shapeFaults(frozen.shape, JSON.parse(await door(...frozen.call) as string)), name).toEqual([]);
    }
  });

  // Review R3 of PR 1844: the shared upload doors' COMPLETE answers, every field Swift decodes, frozen
  // (append-only like the rest): the view in each of its states, the save plan, every effect, the
  // usage counts, and the refusal with its reasons.
  it('shared upload doors: every field of the view, plan, effects, usage and refusal is frozen', () => {
    const door = entry as unknown as Record<string, (...a: unknown[]) => string>;
    const v = (metric: string, x: number, confidence = 'high', more = {}) => ({ metric, valueSI: x, displayValue: x, displayUnit: 'mmol/L', displaySystem: 'si', confidence, ...more });
    const lab = (reportDate: string | null, values: unknown[], more = {}) => ({ classification: 'lab_report', reportDate, values, additionalValues: [], unrecognized: [], document: null, ...more });
    const letter = { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: { classification: 'clinic_letter', title: 'Letter', documentDate: '2026-01-01', contentMarkdown: 'x', metadata: {} } };
    const NO = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };
    const f = (id: string, status: unknown, more = {}) => ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status, ...more });
    const files = [
      f('lab', { s: 'read', extraction: lab('2026-10-01', [v('ldl', 3.1), v('hdl', 1.2, 'low')], { additionalValues: [{ name: 'Ferritin', value: 80, unit: 'µg/L' }], refusedValues: [{ metric: 'creatinine', value: 90, unit: '', reason: 'No unit printed.' }] }), choices: NO }),
      f('undated', { s: 'read', extraction: lab(null, [v('ldl', 3.2)]), choices: NO }),
      f('prev', { s: 'read', extraction: lab('2026-10-02', [v('ldl', 3.3, 'high', { recordedAt: 'undated', printedMonth: '2025-05' })]), choices: NO }),
      f('letter', { s: 'read', extraction: letter, choices: NO }, { pages: { count: 1, truncated: true } }),
      f('bad', { s: 'failed', reason: 'network', attempt: 1 }),
      f('go', { s: 'sending', attempt: 1 }, { zip: 'z.zip' }),
      f('kn', { s: 'known', as: 'document', archiveOnly: true }, { hash: 'h-meta' }),
    ];
    const open = { phase: 'open', platform: 'phone', run: 1, started: NOW, firstRead: NOW, files };
    const record = JSON.stringify({ ...JSON.parse(readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8')),
      documents: [{ id: 'd2', title: 'Held', type: 'clinic_letter', date: '2026-01-01', fileRef: '', contentHash: 'h-meta', mimeType: '', extractedText: '', addedAt: NOW, metadata: {}, sourceFileName: 'kn.pdf' }] });
    const call = (name: string, ...args: unknown[]) => JSON.parse(door[name](...args));
    const row = { fileId: 'string', ref: 'string', label: 'string', reasons: 'object', conflict: 'string?', ticked: 'boolean', replaces: 'string?', replacing: 'boolean', error: 'string?',
      value: 'string', unit: 'string', question: 'string?', unitNote: 'string?', day: 'string?', dayLine: 'string?', replace: 'string?', replaceLabel: 'string?', held: 'string?' };
    const SECTIONS: Record<string, unknown> = {
      undated: { kind: 'string', fileId: 'string', title: 'string', label: 'string', name: 'string', choose: 'string', chosen: 'string?' },
      undatedPrevious: { kind: 'string', fileId: 'string', name: 'string', month: 'string?', before: 'string?' },
      unsure: { kind: 'string', title: 'string', footer: 'string', rows: [row] },
      failed: { kind: 'string', title: 'string', rows: [{ fileId: 'string', name: 'string', line: 'string' }], retry: 'string?' },
      notSaved: { kind: 'string', title: 'string', lines: ['string'], footer: 'string' },
    };
    const view = call('uploadViewJson', JSON.stringify(open), record, NOW, true, 'phone');
    expect(shapeFaults({
      progress: { done: 'number', total: 'number', line: 'string', zip: 'string' }, summary: 'string',
      sure: { line: 'string', showAll: 'string', rows: [row], hide: 'string' },
      documents: {
        line: 'string', rows: [{ fileId: 'string', title: 'string', kind: 'string', date: 'string', dateKnown: 'boolean', kindKey: 'string', day: 'string?' }],
        kinds: [{ key: 'string', word: 'string' }], setDate: 'string', removeDate: 'string',
      },
      files: { row: 'string', rows: [{ fileId: 'string', name: 'string', status: 'string' }] },
      notices: [{ fileId: 'string', name: 'string', line: 'string' }],
      save: { label: 'string', enabled: 'boolean', why: 'string?', error: 'string?' }, stop: { label: 'string' },
      phase: 'string', refused: 'string?', closeEnabled: 'boolean', doneLabel: 'string', engineError: 'string', editable: 'boolean',
    }, view)).toEqual([]);
    expect(view.sections.map((x: { kind: string }) => x.kind).sort()).toEqual(Object.keys(SECTIONS).sort());
    for (const section of view.sections) expect(shapeFaults(SECTIONS[section.kind], section), section.kind).toEqual([]);
    const failed = call('uploadViewJson', JSON.stringify({ ...open, phase: 'saveFailed', attempt: 1, message: 'Could not save.' }), record, NOW, true, 'phone');
    expect(shapeFaults({ save: { label: 'string', enabled: 'boolean', error: 'string' } }, failed)).toEqual([]);
    const done = call('uploadViewJson', JSON.stringify({ ...open, phase: 'done', outcome: { values: 1, documents: 1, archived: 1, unstored: 1 } }), record, NOW, true, 'phone');
    expect(shapeFaults({ done: { line: 'string', archived: 'string', unstored: 'string' } }, done)).toEqual([]);

    const fields = { documentType: 'string', title: 'string', documentDate: 'string?', contentMd: 'string', metadata: 'object', sourceFileName: 'string' };
    const plan = call('uploadSavePlanJson', JSON.stringify({ ...open, files: files.filter((x) => x.id !== 'go') }), record, NOW, true, 'phone');
    expect(shapeFaults({
      labRows: [{ fileId: 'string', rows: [{ kind: 'string', value: 'number', recordedAt: 'string', source: 'string' }] }],
      documents: [{ fileId: 'string', fields }], labArchives: [{ fileId: 'string', sourceFileName: 'string', reportDate: 'string?' }],
      archiveOnly: [{ fileId: 'string', fields }], counts: { values: 'number', documents: 'number', archived: 'number', originals: 'number' },
    }, plan)).toEqual([]);

    // Every effect, from the steps that make them.
    const step = (state: unknown, event: unknown) => call('uploadStepJson', JSON.stringify(state), JSON.stringify(event), '', 'phone');
    const picked = step({ phase: 'choosing', platform: 'phone', run: 0 }, { type: 'picked', needsConsent: false, now: NOW,
      files: [{ id: 'z', name: 'z.zip', bytes: 1, kind: 'zip' }, { id: 'a', name: 'a.pdf', bytes: 1, kind: 'file' }, { id: 'x', name: 'x.exe', bytes: 1, kind: 'file' }] });
    const hashed = step(picked.state, { type: 'hashed', run: 1, id: 'a', hash: 'h-a' });
    const converted = step(hashed.state, { type: 'converted', run: 1, id: 'a', pages: 1, truncated: false });
    const stopped = step(converted.state, { type: 'stop' });
    const saving = step({ ...open, files: files.filter((x) => x.id !== 'go') }, { type: 'saveStarted' });
    const effects = [picked, hashed, converted, stopped, saving].flatMap((x) => x.effects);
    const EFFECTS: Record<string, unknown> = {
      list: { type: 'string', run: 'number', id: 'string' }, hash: { type: 'string', run: 'number', id: 'string' }, convert: { type: 'string', run: 'number', id: 'string' },
      send: { type: 'string', run: 'number', id: 'string', attempt: 'number', flags: { ownDates: 'boolean', undatedPrev: 'boolean', refusedRows: 'boolean' } },
      abort: { type: 'string', run: 'number', ids: ['string'] }, forget: { type: 'string', run: 'number', ids: ['string'] }, save: { type: 'string', run: 'number', attempt: 'number' },
    };
    expect([...new Set(effects.map((x: { type: string }) => x.type))].sort()).toEqual(Object.keys(EFFECTS).sort());
    for (const effect of effects) expect(shapeFaults(EFFECTS[effect.type], effect), effect.type).toEqual([]);

    expect(shapeFaults({ known: 'number', failedFinal: 'number', firstReadSeconds: 'number' }, call('uploadUsageJson', JSON.stringify(open)))).toEqual([]);
    const refusal = call('uploadStepJson', '{', '{}', '', 'phone');
    expect(shapeFaults({ ok: 'boolean', reason: 'string', message: 'string' }, refusal)).toEqual([]);
    expect(UPLOAD_REFUSAL_REASONS).toEqual(['invalid-platform', 'invalid-state', 'invalid-event', 'invalid-record', 'record-too-new', 'engine-error']);
  });

  it('the frozen-shape check catches a dropped or retyped field', () => {
    const shape = [{ name: 'string', units: ['string'] }];
    expect(shapeFaults(shape, [{ name: 'Ferritin', units: ['µg/L'], extra: 1 }])).toEqual([]);
    expect(shapeFaults(shape, [{ units: ['µg/L'] }])).toEqual(['$[0].name: missing']);
    expect(shapeFaults(shape, [{ name: 'Ferritin', units: [1] }])).toEqual(['$[0].units[0]: number, not string']);
  });

  // US-61 / D14: an optional trailing argument or return field keeps the bridge id, so
  // over-the-air engines keep reaching the builds that serve it.
  it('optional additions name only contract doors, add only arguments and returns, and never repeat a contract arg', () => {
    expect(Object.keys(optional).sort()).toEqual(['about', 'doors', 'optionalDoors']);
    for (const [name, door] of Object.entries(optional.doors)) {
      expect(contract.doors[name], name).toBeDefined();
      expect(Object.keys(door).every((k) => k === 'optionalArgs' || k === 'optionalReturns'), name).toBe(true);
      expect((door.optionalArgs?.length ?? 0) > 0 || !!door.optionalReturns, `${name}: optionalArgs or optionalReturns`).toBe(true);
      for (const arg of optionalArgs(name)) expect(contract.doors[name].args, name).not.toContain(arg);
    }
  });

  // PR 399 re-check R1: the count alone let an optional argument move ahead of a contract one.
  it('each optional argument trails the contract ones, by name and in order, in entry.ts', () => {
    for (const name of Object.keys(optional.doors)) {
      if (optionalArgs(name).length === 0) continue; // a return-only addition: no optional argument to place
      expect(parameters(name), name).toEqual([...contract.doors[name].args, ...optionalArgs(name)]);
    }
  });

  // An older app sends only the contract arguments: the door must answer, and answer as if
  // each optional argument were passed as undefined.
  it('every optional door answers an older app\'s call as it answers undefined optional arguments', () => {
    for (const name of Object.keys(optional.doors)) {
      if (optionalArgs(name).length === 0) continue; // a return-only addition: no argument an older app could omit
      const args = SAMPLE_ARGS[name];
      expect(args, `${name}: add its contract arguments to SAMPLE_ARGS`).toBeDefined();
      expect(args.length, name).toBe(contract.doors[name].args.length);
      const door = (entry as unknown as Record<string, (...a: unknown[]) => string>)[name];
      const older = door(...args);
      const undefinedOptional = door(...args, ...optionalArgs(name).map(() => undefined));
      expect(untimed(older), name).toBe(untimed(undefinedOptional));
    }
  });

  // The id the app serves (EngineRelease.bridge). A real bridge change (anything an older
  // app cannot do without) moves the id and updates this literal; bridge-optional.json is
  // never a way around that, only for additions that work both ways (D3, D14). Moved
  // 2026-11-01 (Brad: still in beta, no downloads): US-07 AC8's labEgfrOutdated plus
  // US-61's optional isUS and usProducts; builds 3 and 4 no longer take OTA engines. Moved
  // 2026-11-02: US-12 AC20's limits in the chat context; build 5 no longer takes OTA engines.
  // Moved 2026-11-02 again: US-67's chatEditsJson door, a door an older app cannot serve.
  // Moved again 2026-11-02 for US-72 (D10): the healthRecords edit kind is named in the
  // contract, so an app that sends it never runs an older engine without the case.
  // Moved 2026-11-03: the two merged (US-67's door and the healthRecords edit).
  it('the contract hashes to exactly the bridge id the app serves (40fc97db4ca12547)', () => {
    const bytes = readFileSync(join(__dirname, 'bridge-contract.json'));
    expect(createHash('sha256').update(bytes).digest('hex').slice(0, 16)).toBe('40fc97db4ca12547');
    expect(contract.doors.screenJson.args).toEqual(['recordJson', 'nowIso', 'deviceId', 'unitsJson']);
    expect(optional.doors.screenJson.optionalArgs).toEqual(['isUS']);
  });

  // US-72 (D10): an engine without the healthRecords case would throw on it, so the
  // edit kind and its answer are in the contract, not an optional addition.
  it('names the healthRecords edit and its counts in applyEditJson and cloudEdit', () => {
    expect(contract.doors.applyEditJson.returns).toContain("healthRecords {kind:'healthRecords', records:[{sourceId, resourceType, fhirVersion, json}]}");
    expect(contract.doors.applyEditJson.returns).toContain('{added, corrected, withdrawn, alreadyInRecord, notRead}');
    expect(contract.doors.cloudEdit.returns).toContain('healthRecords');
  });

  // US-72 AC18: the door's answer counts a result with a bad date as undated, inside notRead.
  // The count is optional (contract.schema.json, not bridge-contract.json), so the bridge id
  // above did not move and an answer from an engine before it still parses.
  it('a healthRecords answer counts a bad date as undated, and one without the count still parses', () => {
    const record = entry.newRecordJson(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    const ldl = (id: string, date: Record<string, unknown>) => ({ sourceId: 'src', resourceType: 'Observation', fhirVersion: '4.0.1', json: JSON.stringify({
      resourceType: 'Observation', id, status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '13457-7' }] },
      valueQuantity: { value: 3.1, unit: 'mmol/L' }, issued: '2026-10-02T09:00:00Z', ...date }) });
    const edit = { kind: 'healthRecords', records: [ldl('a', { effectiveDateTime: '2026-10-01' }), ldl('b', { effectivePeriod: { start: 20261001 } }), ldl('c', { effectiveDateTime: '2026-02-30' })] };
    const answer = EDIT_OUTCOME.parse(JSON.parse(entry.applyEditJson(record, JSON.stringify(edit), NOW, 'phone')));
    expect(answer.healthRecords).toEqual({ added: 1, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 2, undated: 2 });
    expect(EDIT_OUTCOME.parse({ ok: true, healthRecords: { added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 1 } }).healthRecords?.undated).toBeUndefined();
  });

  it('every value the engine exports is in the contract', () => {
    const values = Object.entries(entry).filter(([, v]) => typeof v !== 'function').map(([k]) => k);
    expect(values.sort()).toEqual(Object.keys(contract.values).sort());
  });

  it('the natives the engine calls are the contract natives', () => {
    const used = [...members('shim.ts', 'Natives'), ...members('cloud-adapters.ts', 'CloudNatives')];
    expect(used.sort()).toEqual(Object.keys(contract.natives).sort());
  });

  it('the events the engine sends are the contract events', () => {
    const source = ['cloud.ts', 'cloud-adapters.ts'].map((file) => readFileSync(join(__dirname, file), 'utf8')).join('\n');
    const sent = new Set([...source.matchAll(/__native\.notify\('(\w+)'/g)].map((m) => m[1]));
    expect([...sent].sort()).toEqual([...contract.events].sort());
  });

  // US-56 AC8 (adversary R1, Codex R1): from 60 the vo2Bands Low line (p20) can exceed p50
  // (men 80 to 89), which an app built before it cannot draw. Naming the row and that meaning
  // in the contract moves the bridge id, so such an app refuses an engine that serves it.
  it('names the vo2Bands row and its Low line that can exceed p50', () => {
    const returns = contract.doors.screenJson.returns ?? '';
    expect(returns).toContain('myData.vo2Bands is the VO2 max bands row {sex, fromAge, toAge, p20, p50, p80} or null');
    expect(returns).toContain('p20 is the Low line');
    expect(returns).toContain('can exceed p50');
  });
});
