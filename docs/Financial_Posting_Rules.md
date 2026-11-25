# Financial posting rules and reversal contract

Updated 2026-11-24. This extends the previous schema audit without changing migrations 0000 or 0001. The implementation is schema/migration code, not a completed financial service or a PostgreSQL runtime certification.

## Common invariants

Every journal is tenant-owned and denominated in one currency. Each line references a same-tenant, same-currency financial account, is finite/nonnegative, and has exactly one nonzero side. Finalization requires at least two lines and equal nonzero debit/credit totals. Source IDs resolve within the tenant, with source-specific currency rules below. Unsupported sources, including products, product default costs, expected payouts, allocations and reconciliation suggestions, cannot post actual ledger movements.

`financial_accounts.account_role` makes accounting identity explicit without trusting editable names. Existing accounts receive UNCLASSIFIED; assign roles deliberately before new standard postings. No balances or account names are guessed or backfilled. Asset roles are ETSY_RECEIVABLE, ETSY_PAYOUT_CLEARING, PAYONEER, BANK and TRANSFER_CLEARING. SUPPLIER_COST, DIRECT_EXPENSE and SHARED_EXPENSE require EXPENSE accounts; REVENUE requires INCOME. REFUND supports either an INCOME contra-revenue account or an EXPENSE refund account, preserving both representations. Reporting must count that refund once in either representation. A used classified role cannot change. A legacy UNCLASSIFIED account can receive its first explicit role without altering its existing type/currency.

## Standard source rules

Amounts below are the source event's actual amount; these rules define simple debit/credit legs rather than assuming every possible journal's total debits equal a source amount. Splitting a side among matching accounts is supported. Standard entries cannot add compensating wash lines to the same account or override these rules using an explicit declaration.

| Source / event | Amount and currency | Debit leg | Credit leg |
| --- | --- | --- | --- |
| order / INITIAL | net_payable_amount; order currency | ETSY_RECEIVABLE asset | REVENUE income |
| supplier_purchase / INITIAL | total_amount; purchase currency | SUPPLIER_COST expense | Asset or liability payment/payable account |
| supplier_refund / INITIAL | refund_amount; purchase/refund currency | Asset receiving the refund | SUPPLIER_COST expense, reducing cost |
| expense / INITIAL | amount; expense currency | DIRECT_EXPENSE or SHARED_EXPENSE according to expense_type | Asset or liability payment/payable account |
| refund / INITIAL | refund_amount; refund/order currency | REFUND contra-revenue or expense | Asset or liability refunded/owed |
| etsy_payout / INITIAL | actual_amount; payout currency | ETSY_PAYOUT_CLEARING asset | ETSY_RECEIVABLE asset |
| payoneer_transaction DEPOSIT / INITIAL | amount; transaction currency | PAYONEER asset | ETSY_PAYOUT_CLEARING asset |
| payoneer_transaction WITHDRAWAL / INITIAL | amount; transaction currency | TRANSFER_CLEARING asset | PAYONEER asset |
| payoneer_transaction FEE / INITIAL | amount; transaction currency | SHARED_EXPENSE expense | PAYONEER asset |
| payoneer_transaction / FEE | fee_amount; fee_currency | SHARED_EXPENSE expense | PAYONEER asset in that currency |
| bank_withdrawal / INITIAL | actual_pkr_received; PKR | BANK asset | TRANSFER_CLEARING asset in PKR |

A supplier purchase must be confirmed, have a purchase date, matching item totals, and its unique finalized INITIAL posting committed atomically. Costs and purchase items freeze at confirmation. Zero-cost purchases need matching items but no zero-value journal. Supplier refunds require a previously confirmed purchase. Expenses must be CONFIRMED before posting. Partial refunds use their recorded refund amount, never the original order/purchase total. No speculative cumulative cap against Etsy net payable was introduced: that figure does not establish gross customer refunds or fee compensation limits.

Etsy payout and Payoneer deposit remain distinct clearing events. Deposit matches/reconciliation do not create another receipt. The existing withdrawal model keeps the USD principal in the Payoneer transaction and the PKR receipt in bank_withdrawals. USD and PKR TRANSFER_CLEARING accounts are separate. Neither principal leg uses an expense account. Actual PKR received is authoritative; no usd_amount * rate = actual_pkr_received equality is imposed. FX gains/losses require their own explicit adjustment event.

Fees stay separate from principal: an embedded fee uses the transaction's FEE event and fee currency; a standalone FEE transaction uses INITIAL and cannot also post an embedded fee. Preserve the established principal/fee separation when normalizing imports. If a statement reports net rather than principal amounts, the importer must explicitly identify that statement convention instead of subtracting the fee again. Bank fee fields are descriptive, not another posting source.

Source-event uniqueness and idempotency keys prevent repeated postings of the same stored event. They cannot identify two manually entered source rows representing the same real fee or purchase without common provenance. Provider external IDs and import duplicate review remain necessary; do not enter a canonical Payoneer fee or supplier purchase a second time as a manual expense. Categories and free-text references cannot establish that identity reliably. This remaining ingestion limitation is not solved by ledger balancing.

## Explicit instructions for ambiguous events

The user explicitly approved declared legs for refund_adjustment, Payoneer ADJUSTMENT/OTHER, opening_balance and generic adjustment sources. These sources cannot finalize without a financial_posting_events record and financial_posting_legs.

The declaration supplies tenant, source type/ID/event, stable unique event_key, currency, source_amount, amount_basis, and an optional control account. Each leg specifies the tenant-scoped account, explicit currency and one debit/credit amount. Foreign keys require event/account currencies to match. A declaration with missing, unbalanced, zero-only, nonfinite or foreign-tenant legs is rejected when used for posting.

Choose the amount basis explicitly:

- TOTAL_DEBITS measures the sum of all declared debits; source_amount must be positive and no control account is supplied.
- NET_DEBIT measures debits minus credits on the declared control account.
- NET_CREDIT measures credits minus debits on that account.

Net bases support signed source amounts and compound journals whose total debits differ from the source's net movement. The control account must occur in the legs. Refund adjustment and Payoneer ADJUSTMENT/OTHER declarations must match the signed source amount exactly. Opening balances explicitly measure the source financial account with a net basis; their offset accounts and treatment are supplied by the caller. Generic adjustments reference a different finalized same-currency journal and supply an explicit correction-event name and amount/basis. Finalization explicitly rejects an original that already has a same-tenant finalized reversal, even though that original retains FINALIZED status. There is no business-rule exception permitting adjustments against reversed originals. Draft reversal records alone do not mark the original effectively reversed. Deferred validation observes a reversal finalized in the same transaction, regardless of statement order; the existing tenant lock serializes competing writes. No accounting direction is inferred from adjustment_type, descriptions, signs alone, or OTHER.

The journal must match the declaration's full source identity, currency and event_key (as idempotency_key), then match the exact multiset of declared account/debit/credit/currency legs. Event keys, source tuples and journal declaration references have tenant-scoped uniqueness. Instructions can be staged while draft, but their header and all legs become immutable after finalization, including inserting additional legs or moving legs into/out of a finalized declaration. Corrections require a new event.

## Atomic journal reversals

`SELECT reverse_journal_entry(tenant_id, original_entry_id, stable_event_key, reversal_timestamp)` runs within the caller's transaction. It locks the tenant/original, creates a draft adjustment with source_event REVERSAL and reversal_of_entry_id, copies every original line with debit and credit exchanged, and finalizes the new entry. Any statement failure rolls back the function's writes; deferred constraints validate before the transaction commits. The application must commit before acknowledging success.

The original remains FINALIZED and immutable. The new reversal is also FINALIZED and immutable. Effective reversal status is derived by joining a finalized entry whose reversal_of_entry_id points to the original. This preserves history without updating the original's status. The legacy REVERSED enum remains for existing data, but new INSERTs or draft transitions to it are forbidden. Existing legacy rows remain immutable; this migration does not certify how those rows were created.

A composite tenant/original/currency FK prevents cross-tenant/currency reversals. A unique tenant/original index permits at most one reversal, including a staged draft. Self-reference, reversing drafts, reversing a reversal, and reversal chains are rejected. Reversal line validation compares multisets with EXCEPT ALL so account IDs, currency, split lines and duplicate multiplicity must be exact opposites. A retry with the same key returns the existing finalized reversal; a different key attempting a second reversal fails. Generic corrections remain separate explicit events and cannot masquerade as REVERSAL.

An ordinary caller must derive tenant from an authenticated session; the SQL function is security-invoker, not an authorization bypass. Runtime roles must not own tables or have TRUNCATE, trigger-disabling, or arbitrary trigger-creation privileges. Composite foreign keys prevent invalid relationships but do not implement SELECT authorization or RLS.

## Migration and testing status

Run the complete migration chain, never drizzle-kit push. Existing 0000/0001 files are preserved by SHA-256 regression checks. New files are 0002_reversals_and_shipments, 0003_explicit_posting_events, 0004_financial_account_roles, 0005_financial_posting_hardening and 0006_shipment_history_integrity. Table definitions and referenced UNIQUE keys precede foreign keys; new functions follow their required schema. Forward migration 0007_integrity_followup.sql adds the reversed-original check, shipment creation-date floor, and complete notes audit snapshots. Migrations 0000–0006 remain unchanged. The maintained financial-integrity.sql is the cumulative 0001 + 0005 + financial-followup.sql source; shipment-integrity.sql is cumulative 0006 + shipment-followup.sql. The two follow-up sources compose migration 0007 exactly.

No database or migrations were executed for this task. A local PostgreSQL client exists, but no dedicated disposable test database was configured. Integration cases are supplied and explicitly skipped until one is available. Offline checks exercise schema metadata, migration ordering/history/source parity, environment loading and the version-specific auth field manifest; they do not execute PostgreSQL triggers. Future integration testing must include concurrency/serialization retries, legacy data review and runtime privileges. Tenant-level locking is retained to serialize financial writes; it favors integrity over throughput.

Previously finalized malformed entries are not retroactively repaired or silently rewritten. Review historical data separately before deploying these guards. New standard postings require explicit account role assignment; existing draft ambiguous entries need complete declarations before finalization.


## Local validation completion (2026-11-24)

The historical no-database status above is superseded by the [executed integration report](Database_Integration_Test_Report.md). The full chain 0000–0007 ran unchanged on disposable PostgreSQL 18.6. One genuine trigger defect rejected negative Payoneer adjustments because a zero reconciliation sum was compared to a negative non-deposit amount. Forward migration 0008 limits that capacity comparison to DEPOSIT transactions, preserving the separate rule forbidding reconciliation to non-deposits. Current maintained financial-integrity.sql appends allocation-validation.sql, which matches 0008 exactly. All 71 sequential and 12 concurrency/rollback/retry cases passed with no skips. The migration chain is frozen; new changes require a concrete requirement or reproduced defect.
