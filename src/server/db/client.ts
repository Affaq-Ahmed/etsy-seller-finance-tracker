import 'server-only';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';

/** Connection cap per client (ARCHITECTURE.md §2.1). */
export const DB_POOL_MAX = 5;

export type Database = PostgresJsDatabase<typeof schema>;
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run tenant queries: the pooled client or an open transaction. */
export type DbExecutor = Database | DbTransaction;

export interface DbHandle {
  readonly db: Database;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string, options: { readonly max?: number } = {}): DbHandle {
  const client = postgres(databaseUrl, { max: options.max ?? DB_POOL_MAX, onnotice: () => undefined });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
