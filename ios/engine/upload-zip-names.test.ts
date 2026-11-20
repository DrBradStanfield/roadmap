// PR 1908 review (US-52 AC8c, AC13d; US-12 AC9): a ZIP member in the shared upload goes by the name the
// old iPhone path and the web file it under, `zip/member` (health-core zipMemberName), for the legacy
// match, the save's sourceFileName, the Files list and the failure lines. Synthetic names and text only.
import { describe, expect, it } from 'vitest';
import { fileNamesJson, uploadSaveJson, uploadStepJson, uploadViewJson } from './entry';
import { NO_CHOICES } from '../../packages/health-core/src/upload-choices';
import { createEmptyFile, type FileDocument, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-11-01T00:00:00.000Z';
const undatedLetter = (title: string) => ({
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'clinic_letter', title, documentDate: null, contentMarkdown: `# ${title}`, metadata: {} },
});
const held = (over: Partial<FileDocument>): FileDocument => ({
  id: 'doc-1', title: 'Old letter', type: 'clinic_letter', date: null, fileRef: '', contentHash: '', mimeType: 'application/pdf',
  extractedText: '# Old letter', addedAt: '2026-01-01T00:00:00.000Z', metadata: {}, sourceFileName: 'letter.pdf', ...over,
});
const recordOf = (...documents: FileDocument[]): string => JSON.stringify({ ...createEmptyFile({ deviceId: 'test', now: NOW }), documents } satisfies RoadmapFile);
const member = (status: unknown, over: Record<string, unknown> = {}) =>
  ({ id: 'z#0', name: 'letter.pdf', zip: 'records.zip', bytes: 1, hash: 'sha256-new', pages: { count: 1, truncated: false }, status, ...over });
const state = (phase: string, files: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ phase, platform: 'phone', run: 1, started: NOW, firstRead: null, files, ...extra });
const OLD_PATH_NAME = (JSON.parse(fileNamesJson(JSON.stringify([{ zip: 'records.zip', path: 'letter.pdf' }]))) as string[])[0];

describe('a ZIP member goes by its archive-qualified name (PR 1908 review, US-52 AC13d)', () => {
  it('a different undated letter.pdf inside records.zip is offered, though the record holds an undated hashless letter.pdf', () => {
    const record = recordOf(held({}));
    const answered = JSON.parse(uploadStepJson(state('open', [member({ s: 'sending', attempt: 1 })]),
      JSON.stringify({ type: 'answered', run: 1, id: 'z#0', extraction: undatedLetter('New letter'), now: NOW }), record, 'phone'));
    expect(answered.state.files[0].status.s).toBe('read');
    const view = JSON.parse(uploadViewJson(JSON.stringify(answered.state), record, NOW, false, 'phone'));
    expect(view.files.rows.map((r: { name: string }) => r.name)).toEqual([OLD_PATH_NAME]);
  });

  it('Save files it under the name the old path wrote for the same ZIP member', async () => {
    const saving = state('saving', [member({ s: 'read', extraction: undatedLetter('New letter'), choices: NO_CHOICES })], { attempt: 1 });
    const answer = JSON.parse(await uploadSaveJson(saving, recordOf(held({})), '', NOW, 'phone', '{}', () => null));
    expect(answer).toMatchObject({ ok: true, outcome: { documents: 1 } });
    const saved = (JSON.parse(answer.record) as RoadmapFile).documents.find((d) => d.title === 'New letter');
    expect(OLD_PATH_NAME).toBe('records.zip/letter.pdf');
    expect(saved?.sourceFileName).toBe(OLD_PATH_NAME);
  });

  it('a member re-read from the same ZIP still matches the hashless row the old path wrote under its name', () => {
    const record = recordOf(held({ sourceFileName: OLD_PATH_NAME }));
    const answered = JSON.parse(uploadStepJson(state('open', [member({ s: 'sending', attempt: 1 })]),
      JSON.stringify({ type: 'answered', run: 1, id: 'z#0', extraction: undatedLetter('Any title'), now: NOW }), record, 'phone'));
    expect(answered.state.files[0].status).toMatchObject({ s: 'known', as: 'legacy' });
  });

  it('a member whose bytes a saved document holds is still skipped as known, by its hash', () => {
    const record = recordOf(held({ contentHash: 'sha256-same', date: '2026-09-01', sourceFileName: 'elsewhere.pdf' }));
    const hashed = JSON.parse(uploadStepJson(state('open', [member({ s: 'hashing' }, { hash: null })]),
      JSON.stringify({ type: 'hashed', run: 1, id: 'z#0', hash: 'sha256-same' }), record, 'phone'));
    expect(hashed.state.files[0].status.s).toBe('known');
  });

  it('a failed member is named by its archive-qualified name', () => {
    const view = JSON.parse(uploadViewJson(state('open', [member({ s: 'failed', reason: 'busy', attempt: 1 })]), recordOf(), NOW, false, 'phone'));
    const failed = view.sections.find((x: { kind: string }) => x.kind === 'failed');
    expect(failed.rows.map((r: { name: string }) => r.name)).toEqual([OLD_PATH_NAME]);
  });
});
