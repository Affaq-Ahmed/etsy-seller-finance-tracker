import 'server-only';
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { journalEntries, journalLines } from '@/db/schema';
import { expectRow, type TenantInsert, type TenantRow, type TenantScope } from './tenant-scope';

// The ledger tables are append-only once finalized (database triggers). These
// functions only create a DRAFT entry, its lines, and finalize it; posting
// rules and balance are validated by the database at COMMIT.

export type JournalEntryRow = TenantRow<typeof journalEntries>;
export type JournalEntryInsert = TenantInsert<typeof journalEntries>;
export type JournalLineInsert = TenantInsert<typeof journalLines>;

export async function insertDraftJournalEntry(scope: TenantScope, values: JournalEntryInsert): Promise<JournalEntryRow> {
  return expectRow(await scope.insert(journalEntries, [{ ...values, status: 'DRAFT' }]));
}

export async function insertJournalLines(scope: TenantScope, rows: readonly JournalLineInsert[]): Promise<void> {
  await scope.insert(journalLines, rows);
}

export async function finalizeJournalEntry(scope: TenantScope, entryId: string, finalizedAt: Date): Promise<void> {
  const updated = await scope.update(journalEntries, { status: 'FINALIZED', finalizedAt }, eq(journalEntries.id, entryId));
  if (updated.length !== 1) throw new Error('Journal entry could not be finalized');
}

/** The posting for one source event (e.g. a purchase's INITIAL entry), if any. */
export async function findJournalEntryBySource(
  scope: TenantScope, sourceType: string, sourceId: string, sourceEvent: string,
): Promise<JournalEntryRow | null> {
  const [row] = await scope.select(journalEntries, and(
    eq(journalEntries.sourceType, sourceType), eq(journalEntries.sourceId, sourceId), eq(journalEntries.sourceEvent, sourceEvent),
  ));
  return row ?? null;
}

/** The finalized reversal of an entry, if one exists. */
export async function findFinalizedReversalOf(scope: TenantScope, entryId: string): Promise<JournalEntryRow | null> {
  const [row] = await scope.select(journalEntries, and(eq(journalEntries.reversalOfEntryId, entryId), eq(journalEntries.status, 'FINALIZED')));
  return row ?? null;
}

/**
 * Exact opposite reversal through the database function
 * `reverse_journal_entry(tenant, original, event_key, reversed_at)`. A retry
 * with the same event key returns the existing reversal; a different key on an
 * already reversed original is rejected by the database. The tenant argument is
 * always the session tenant.
 */
export async function reverseJournalEntry(scope: TenantScope, originalEntryId: string, eventKey: string, reversedAt: Date): Promise<string> {
  const rows = await scope.executor.execute<{ reversal_id: string }>(
    sql`SELECT reverse_journal_entry(${scope.tenant.accountId}::uuid, ${originalEntryId}::uuid, ${eventKey}, ${reversedAt.toISOString()}::timestamptz) AS reversal_id`,
  );
  const reversalId = rows[0]?.reversal_id;
  if (!reversalId) throw new Error('Reversal did not return an entry');
  return reversalId;
}

/**
 * SQL predicate (columns or raw expressions such as `sql.raw('sp.id')`): the supplier purchase has a finalized reversal of its INITIAL
 * posting. A reversed purchase keeps status CONFIRMED (confirmed rows are
 * immutable); its reversed state is derived from the ledger.
 */
export function purchaseIsReversedSql(accountIdColumn: SQLWrapper, purchaseIdColumn: SQLWrapper): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM journal_entries initial_entry
    JOIN journal_entries reversal ON reversal.account_id = initial_entry.account_id
      AND reversal.reversal_of_entry_id = initial_entry.id AND reversal.status = 'FINALIZED'
    WHERE initial_entry.account_id = ${accountIdColumn} AND initial_entry.source_type = 'supplier_purchase'
      AND initial_entry.source_id = ${purchaseIdColumn} AND initial_entry.source_event = 'INITIAL')`;
}
