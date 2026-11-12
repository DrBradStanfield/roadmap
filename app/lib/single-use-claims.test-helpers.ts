/**
 * An in-memory stand-in for the admin client, enough for `single_use_claims`:
 * a primary-key insert that answers 23505 on a repeat, and the delete of old
 * rows of one kind. Every other table is inert, so a suite that mocks the admin
 * client with this keeps its product events quiet. The state is the caller's,
 * made in `vi.hoisted`, so module resets in a suite still share one store.
 */
export interface ClaimsState {
  rows: Map<string, { kind: string; createdAt: number }>;
  /** 'throw': the client rejects. 'error': it answers an error, as a missing table does. */
  down: false | 'throw' | 'error';
}

export function newClaimsState(): ClaimsState {
  return { rows: new Map(), down: false };
}

const OK = { data: null, error: null };
const MISSING = { data: null, error: { code: 'PGRST205', message: 'table not found' } };

/** Any chain on another table resolves to an empty success. */
const inert: unknown = new Proxy(() => undefined, {
  get: (_target, prop) => (prop === 'then' ? (resolve: (v: unknown) => void) => resolve(OK) : inert),
  apply: () => inert,
});

export function claimsAdmin(state: ClaimsState) {
  const reach = () => {
    if (state.down === 'throw') throw new Error('fetch failed');
    return state.down !== 'error';
  };
  return {
    from(table: string) {
      if (table !== 'single_use_claims') return inert;
      return {
        async insert(row: { key: string; kind: string }) {
          if (!reach()) return MISSING;
          if (state.rows.has(row.key)) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
          state.rows.set(row.key, { kind: row.kind, createdAt: Date.now() });
          return OK;
        },
        delete: () => ({
          eq: (_column: 'kind', kind: string) => ({
            async lt(_column: 'created_at', iso: string) {
              if (!reach()) return MISSING;
              for (const [key, row] of state.rows) if (row.kind === kind && row.createdAt < Date.parse(iso)) state.rows.delete(key);
              return OK;
            },
          }),
        }),
      };
    },
  };
}
