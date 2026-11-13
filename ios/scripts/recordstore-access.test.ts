// US-25 AC11 (the cloud source): PR 1384 split RecordStore.swift and widened members from private to
// internal, since Swift private cannot cross files. The Source union PR (US-25 AC11o) took back what it
// could: `source`, `recordJSON` and `problem` are private(set) and `cloudErase` is get-only, so the
// compiler guards them; `show`, `applyInCloud` and `shownOrder` are private; cloudSession, cloudName,
// cloudAccount and marksPending are gone. What is still internal, because RecordStore+*.swift writes or
// calls it, is guarded here: no write to those members and no call to those writers outside
// MyData/RecordStore*.swift, and the source's one public door, `link`, only from Sync/CloudSync.swift.
// Limits: a regex, not a parser. An assignment split over more than two lines, or a store reached
// through a receiver not named `...store`/`...Store` or `$N`, is not seen.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const APP = join(__dirname, '..', 'HealthRoadmap');
const MEMBERS = '(?:ownSaves|unitSwitches|histories|reading)';
const WRITERS = '(?:display|publish|draw|shown|forgetCharts|clearsChoices|commitPhoneDocument|applyInTurn)';
const PRIVATE = '(?:histories|reading)'; // fully private before PR 1384: any use is new
const STORE = '\\b\\w*[sS]tore[?!]?\\.'; // app.store, recordStore, store!, RecordStore (static)
const RECV = `(?:${STORE}|\\$\\d+[?!]?\\.)`; // $0 only for member writes: OnboardingView's $0.show( is not ours
const SUB = '(?:\\[[^\\n]*?\\])?(?:\\??\\.\\w+)*'; // [k], [a[b]], ?.chart
const ASSIGN = '\\s*[-+*]?=(?!=)';
const MUTATE = '\\??\\.(?:append|insert|remove\\w*|updateValue|merge)\\(';
const tuple = (recv: string) => `\\(\\s*[^()=]*${recv}${MEMBERS}\\b[^()=]*\\)${ASSIGN}`;
const ANY = new RegExp([
  `${RECV}${MEMBERS}\\b${SUB}(?:${ASSIGN}|${MUTATE})`,
  `${STORE}${WRITERS}\\(`,
  tuple(RECV),
  `\\\\(?:RecordStore)?\\.${MEMBERS}\\b`, // keypaths
  `${RECV}${PRIVATE}\\b`,
  '\\b(?:Stamp|KeptHistory)\\b',
].join('|'));
// Inside `extension RecordStore` a write needs no receiver (R2). A let/var/case tuple is a binding.
const IN_EXTENSION = new RegExp(`^\\s*(?:self\\.)?${MEMBERS}\\b${SUB}${ASSIGN}|^(?!.*\\b(?:let|var|case)\\s*\\().*${tuple('(?:self\\.)?\\b')}`);
const LINK = new RegExp(`${STORE}link\\(`);

const swiftFiles = () => (readdirSync(APP, { recursive: true }) as string[]).filter((f) => f.endsWith('.swift'));

/** Each line of `f` that `hit` matches, alone or joined with the next one (an assignment split over two lines). */
const hits = (f: string, hit: (s: string, text: string) => boolean) => {
  const text = readFileSync(join(APP, f), 'utf8');
  const lines = text.split('\n');
  return lines.flatMap((line, i) => {
    const next = lines[i + 1] ?? '';
    const is = (s: string) => hit(s, text);
    return is(line) || (!is(next) && is(`${line} ${next.trim()}`)) ? [`ios/HealthRoadmap/${f}:${i + 1}: ${line.trim()}`] : [];
  });
};

it('only MyData/RecordStore*.swift writes the members PR 1384 widened and still internal', () => {
  const found = swiftFiles()
    .filter((f) => !/^MyData\/RecordStore[^/]*\.swift$/.test(f))
    .flatMap((f) => hits(f, (s, text) => ANY.test(s) || (/\bextension RecordStore\b/.test(text) && IN_EXTENSION.test(s))));
  expect(found, 'These RecordStore members are internal only so RecordStore+*.swift can reach them; write them inside RecordStore*.swift.').toEqual([]);
});

it('only CloudSync links the store (lead S23)', () => {
  const found = swiftFiles()
    .filter((f) => f !== 'Sync/CloudSync.swift' && !/^MyData\/RecordStore[^/]*\.swift$/.test(f))
    .flatMap((f) => hits(f, (s) => LINK.test(s)));
  expect(found, 'RecordStore.link is CloudSync\'s door to the source; nothing else sets the link.').toEqual([]);
});

// Lead S52 (US-25 AC16f, AC21): a record an erase replaced, its draw failed, is still held by the store
// (`predatesErase`). Everything outside the store reads the record through `readable`, nil then, so no reader
// can forget the check. Only the files listed here read `recordJSON`, `drawn` or `heldData`; a new
// RecordStore*.swift must be added to the list on purpose. HealthRoadmapTests is outside APP, so exempt.
// Limits: a regex, as above. Inside `extension RecordStore` outside the list, a bare read is caught; a
// read through a receiver not named `...store`/`...Store` is not.
const RECORD_READERS = [
  'MyData/RecordStore.swift',
  'MyData/RecordStore+Charts.swift',
  'MyData/RecordStore+Chat.swift',
  'MyData/RecordStore+Documents.swift',
  'MyData/RecordStore+Mark.swift',
  'MyData/RecordStore+Readable.swift',
  'MyData/RecordStore+Source.swift',
  'MyData/RecordStore+Units.swift',
  'MyData/RecordStore+Uploads.swift',
];
const HELD = '(?:recordJSON|drawn|heldData)';
const HELD_READ = new RegExp(`${STORE}${HELD}\\b|\\\\(?:RecordStore)?\\.${HELD}\\b`);
// A bare or self. read, never an argument label or parameter (`recordJSON:`), a member of something else
// (`loaded.drawn`) or a type (`HealthEngine.Drawn`).
const BARE_READ = new RegExp(`(?<![\\w.$\\\\])(?:self\\.)?${HELD}\\b(?!\\s*:(?!:))`);
const code = (line: string) => line.replace(/\/\/.*$/, '');

/** The line numbers (0-based) inside each `extension RecordStore { ... }` block of `text`. */
const extensionLines = (text: string) => {
  const inside = new Set<number>();
  let depth = 0;
  let open = false;
  text.split('\n').forEach((line, i) => {
    const c = code(line);
    if (!open && /\bextension RecordStore\b/.test(c)) [open, depth] = [true, 0];
    if (!open) return;
    inside.add(i);
    for (const ch of c) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
    if (depth <= 0 && c.includes('}')) open = false;
  });
  return inside;
};

it('only the listed RecordStore files read recordJSON, drawn or heldData (lead S52)', () => {
  const found = swiftFiles()
    .filter((f) => !RECORD_READERS.includes(f))
    .flatMap((f) => {
      const text = readFileSync(join(APP, f), 'utf8');
      const inside = extensionLines(text);
      return text.split('\n').flatMap((line, i) =>
        HELD_READ.test(code(line)) || (inside.has(i) && BARE_READ.test(code(line))) ? [`ios/HealthRoadmap/${f}:${i + 1}: ${line.trim()}`] : []);
    });
  expect(found, 'Read the record through store.readable (RecordStore+Readable.swift): nil while it predates an erase.').toEqual([]);
});

it('every RecordStore*.swift is on the S52 reader list on purpose', () => {
  const stores = swiftFiles().filter((f) => /^MyData\/RecordStore[^/]*\.swift$/.test(f));
  expect(stores.filter((f) => !RECORD_READERS.includes(f)), 'A new RecordStore*.swift: add it to RECORD_READERS only if it must read the held record.').toEqual([]);
  expect(RECORD_READERS.filter((f) => !stores.includes(f)), 'A listed file is gone: take it off RECORD_READERS.').toEqual([]);
});
