import type { Transaction } from './model';

/** Synthetic claims for the executable examples and fault tests. */
export function transaction(id: string, options: Partial<Transaction> = {}): Transaction {
  return { protocol: 1, recordId: 'record', generation: 0, operationId: id, writerId: id, sequence: 1,
    dependsOn: [], edits: [{ key: id, expected: null, value: id }], ...options };
}
