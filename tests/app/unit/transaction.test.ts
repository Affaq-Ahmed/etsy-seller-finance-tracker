import { describe, expect, it, vi } from 'vitest';
import type { Database, DbTransaction } from '@/server/db/client';
import { isRetryableTransactionError, runInTransaction, TRANSACTION_MAX_ATTEMPTS } from '@/server/db/transaction';

const pgError = (code: string) => Object.assign(new Error('Failed query'), { cause: { code } });

function fakeDb(outcomes: Array<'ok' | string>) {
  const transaction = vi.fn(async (work: (tx: DbTransaction) => Promise<string>) => {
    const outcome = outcomes.shift();
    if (outcome !== 'ok') throw pgError(outcome ?? 'XX000');
    return work({} as DbTransaction);
  });
  // The fake implements only the method runInTransaction uses.
  return { db: { transaction } as unknown as Database, transaction };
}

describe('runInTransaction', () => {
  it('retries serialization failures and deadlocks, then succeeds', async () => {
    const { db, transaction } = fakeDb(['40001', '40P01', 'ok']);
    await expect(runInTransaction(db, async () => 'done')).resolves.toBe('done');
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('stops after the bounded number of attempts', async () => {
    const { db, transaction } = fakeDb(['40001', '40001', '40001', 'ok']);
    await expect(runInTransaction(db, async () => 'done')).rejects.toThrow('Failed query');
    expect(transaction).toHaveBeenCalledTimes(TRANSACTION_MAX_ATTEMPTS);
  });

  it('does not retry integrity violations', async () => {
    const { db, transaction } = fakeDb(['23505', 'ok']);
    await expect(runInTransaction(db, async () => 'done')).rejects.toThrow();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('classifies retryable codes only', () => {
    expect(isRetryableTransactionError(pgError('40001'))).toBe(true);
    expect(isRetryableTransactionError(pgError('40P01'))).toBe(true);
    expect(isRetryableTransactionError(pgError('23514'))).toBe(false);
    expect(isRetryableTransactionError(new Error('plain'))).toBe(false);
  });
});
