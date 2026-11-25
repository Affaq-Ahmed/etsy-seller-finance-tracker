import 'server-only';
import type { Database, DbTransaction } from './client';
import { getPostgresErrorCode, PG_DEADLOCK_DETECTED, PG_SERIALIZATION_FAILURE } from './errors';

/** Bounded whole-transaction retry (ARCHITECTURE.md §4.6, §5). */
export const TRANSACTION_MAX_ATTEMPTS = 3;

const RETRYABLE_CODES: ReadonlySet<string> = new Set([PG_SERIALIZATION_FAILURE, PG_DEADLOCK_DETECTED]);

export function isRetryableTransactionError(error: unknown): boolean {
  const code = getPostgresErrorCode(error);
  return code !== undefined && RETRYABLE_CODES.has(code);
}

/**
 * Runs `work` in one transaction and resolves only after COMMIT. On
 * serialization failure or deadlock the whole transaction is retried, so
 * `work` must be safe to re-run (it is, because a rolled-back attempt leaves
 * nothing behind).
 */
export async function runInTransaction<T>(
  db: Database,
  work: (tx: DbTransaction) => Promise<T>,
  maxAttempts: number = TRANSACTION_MAX_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(work);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableTransactionError(error)) throw error;
    }
  }
}
