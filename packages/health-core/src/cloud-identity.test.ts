// US-09 AC67: the provider's answer is judged into closed words, and nothing
// from the body comes back out. Table tests for both classifiers.
import { describe, expect, it } from 'vitest';
import { classifyCopies, classifyIdentityRead, copyBucket, type IdentityOutcome, type IdentityProvider } from './cloud-identity';

const ID = 'test-id-one';

describe('classifyIdentityRead (US-09 AC67)', () => {
  const rows: Array<[IdentityProvider, number | null, unknown, IdentityOutcome]> = [
    ['google-drive', 200, { user: { permissionId: ID } }, 'ok'],
    ['google-drive', 200, { user: {} }, 'missing'],
    ['google-drive', 200, { user: { permissionId: '' } }, 'missing'],
    ['google-drive', 200, { user: { permissionId: 7 } }, 'missing'],
    ['google-drive', 200, {}, 'missing'],
    ['dropbox', 200, { account_id: `dbid:${ID}`, email: 'a@example.test' }, 'ok'],
    ['dropbox', 200, { email: 'a@example.test' }, 'missing'],
    ['github', 200, { id: 42, login: 'someone' }, 'ok'],
    ['github', 200, { id: '42' }, 'missing'],
    ['github', 200, { id: 0 }, 'missing'],
    ['github', 200, { id: 1.5 }, 'missing'],
    // Not a JSON object.
    ['google-drive', 200, undefined, 'malformed'],
    ['dropbox', 200, 'text', 'malformed'],
    ['github', 200, null, 'malformed'],
    ['github', 200, [{ id: 42 }], 'malformed'],
    // The provider refused the token.
    ['google-drive', 401, { error: 'x' }, 'refused'],
    ['dropbox', 403, undefined, 'refused'],
    // Any other answer, or none.
    ['github', 404, undefined, 'unreachable'],
    ['google-drive', 429, undefined, 'unreachable'],
    ['dropbox', 500, { account_id: ID }, 'unreachable'],
    ['github', 302, undefined, 'unreachable'],
    ['google-drive', null, undefined, 'unreachable'],
  ];
  it.each(rows)('%s %s %j -> %s', (provider, status, body, outcome) => {
    expect(classifyIdentityRead(provider, status, body)).toBe(outcome);
  });
});

describe('classifyCopies (US-09 AC67)', () => {
  const files = (owned: number, notOwned: number) => [
    ...Array.from({ length: owned }, () => ({ ownedByMe: true })),
    ...Array.from({ length: notOwned }, () => ({ ownedByMe: false })),
  ];
  const rows: Array<[string, number | null, unknown, object]> = [
    ['none listed', 200, { files: [] }, { outcome: 'ok', owned: '0', notOwned: '0' }],
    ['one owned', 200, { files: files(1, 0) }, { outcome: 'ok', owned: '1', notOwned: '0' }],
    ['one of each', 200, { files: files(1, 1) }, { outcome: 'ok', owned: '1', notOwned: '1' }],
    ['many', 200, { files: files(3, 2) }, { outcome: 'ok', owned: '2+', notOwned: '2+' }],
    ['a closed search flag', 200, { files: files(2, 0), incompleteSearch: false }, { outcome: 'ok', owned: '2+', notOwned: '0' }],
    // Partial lists are not followed: the counts seen so far, said as incomplete.
    ['a partial search', 200, { files: files(1, 0), incompleteSearch: true }, { outcome: 'incomplete', owned: '1', notOwned: '0' }],
    ['a second page', 200, { files: files(2, 1), nextPageToken: 'page-two' }, { outcome: 'incomplete', owned: '2+', notOwned: '1' }],
    // A body that does not parse carries no counts.
    ['no files list', 200, {}, { outcome: 'incomplete' }],
    ['a file without ownedByMe', 200, { files: [{}] }, { outcome: 'incomplete' }],
    ['not JSON', 200, undefined, { outcome: 'incomplete' }],
    ['refused', 401, undefined, { outcome: 'refused' }],
    ['forbidden', 403, undefined, { outcome: 'refused' }],
    ['server error', 500, { files: [] }, { outcome: 'unreachable' }],
    ['no answer', null, undefined, { outcome: 'unreachable' }],
  ];
  it.each(rows)('%s', (_name, status, body, expected) => {
    expect(classifyCopies(status, body)).toEqual(expected);
  });

  it('buckets a count', () => {
    expect([0, 1, 2, 100].map(copyBucket)).toEqual(['0', '1', '2+', '2+']);
  });
});
