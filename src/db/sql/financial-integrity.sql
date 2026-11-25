-- Custom migration source. Drizzle schema generation does not emit triggers.
-- Runtime roles must not own tables, disable triggers, or TRUNCATE financial data.
CREATE FUNCTION guard_journal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Finalized/reversed journal entries are immutable; create an adjustment';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_entry_immutable BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION guard_journal_entry();
--> statement-breakpoint
CREATE FUNCTION guard_journal_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent journal_entries;
BEGIN
  -- Lock the parent so finalization cannot race a line mutation.
  FOR parent IN SELECT * FROM journal_entries
    WHERE id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.journal_entry_id END,
                 CASE WHEN TG_OP <> 'DELETE' THEN NEW.journal_entry_id END)
    ORDER BY id FOR UPDATE
  LOOP
    IF parent.status <> 'DRAFT' THEN RAISE EXCEPTION 'Finalized journal lines are immutable'; END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_line_immutable BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION guard_journal_line();
--> statement-breakpoint
CREATE FUNCTION validate_finalized_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry journal_entries; line_count bigint; debits numeric; credits numeric;
  source_row record; source_table text;
BEGIN
  SELECT * INTO entry FROM journal_entries WHERE id = NEW.id;
  IF NOT FOUND OR entry.status = 'DRAFT' THEN RETURN NULL; END IF;
  SELECT count(*), sum(debit_amount), sum(credit_amount) INTO line_count, debits, credits
    FROM journal_lines WHERE account_id = entry.account_id AND journal_entry_id = entry.id;
  IF line_count < 2 OR debits IS DISTINCT FROM credits OR debits <= 0 THEN
    RAISE EXCEPTION 'Finalized journal must have at least two nonzero balanced lines';
  END IF;
  -- A closed source vocabulary prevents allocations, estimates or product costs
  -- from masquerading as actual financial events. Extend with a reviewed migration.
  source_table := CASE entry.source_type
    WHEN 'order' THEN 'orders' WHEN 'supplier_purchase' THEN 'supplier_purchases'
    WHEN 'supplier_refund' THEN 'supplier_refunds' WHEN 'expense' THEN 'expenses'
    WHEN 'refund' THEN 'refunds' WHEN 'refund_adjustment' THEN 'refund_adjustments'
    WHEN 'etsy_payout' THEN 'etsy_payouts' WHEN 'payoneer_transaction' THEN 'payoneer_transactions'
    WHEN 'bank_withdrawal' THEN 'bank_withdrawals' WHEN 'adjustment' THEN 'journal_entries'
    WHEN 'opening_balance' THEN 'financial_accounts' ELSE NULL END;
  IF source_table IS NULL THEN RAISE EXCEPTION 'Unsupported financial source: %', entry.source_type; END IF;
  IF entry.source_type NOT IN ('adjustment','opening_balance','payoneer_transaction') AND entry.source_event <> 'INITIAL' THEN
    RAISE EXCEPTION 'Business events have one INITIAL posting; corrections require a new adjustment source';
  END IF;
  IF entry.source_type = 'opening_balance' AND entry.source_event <> 'INITIAL' THEN
    RAISE EXCEPTION 'An account has one opening balance';
  END IF;
  IF entry.source_type = 'payoneer_transaction' AND entry.source_event NOT IN ('INITIAL','FEE') THEN
    RAISE EXCEPTION 'Payoneer event must be INITIAL or FEE';
  END IF;
  EXECUTE format('SELECT * FROM %I WHERE account_id = $1 AND id = $2 FOR UPDATE', source_table)
    INTO source_row USING entry.account_id, entry.source_id;
  IF source_row IS NULL THEN RAISE EXCEPTION 'Journal source must exist in the same tenant'; END IF;
  IF entry.source_type = 'payoneer_transaction' AND entry.source_event = 'FEE' THEN
    IF source_row.fee_amount IS NULL OR source_row.fee_amount <= 0 OR source_row.fee_currency <> entry.currency
      OR debits <> source_row.fee_amount THEN RAISE EXCEPTION 'Fee posting must match the transaction fee'; END IF;
  ELSIF entry.source_type <> 'bank_withdrawal' THEN
    IF source_row.currency <> entry.currency THEN RAISE EXCEPTION 'Journal currency must match its source'; END IF;
  END IF;
  IF entry.source_type = 'supplier_purchase' THEN
    IF source_row.confirmed_at IS NULL OR source_row.status NOT IN ('CONFIRMED','PARTIALLY_REFUNDED','REFUNDED') THEN
      RAISE EXCEPTION 'Supplier costs require a confirmed purchase';
    END IF;
    IF entry.source_event = 'INITIAL' AND (debits <> source_row.total_amount OR
      (SELECT coalesce(sum(l.debit_amount - l.credit_amount),0) FROM journal_lines l
       JOIN financial_accounts a ON a.id = l.financial_account_id AND a.account_id = l.account_id
       WHERE l.journal_entry_id = entry.id AND a.account_type = 'EXPENSE') <> source_row.total_amount) THEN
      RAISE EXCEPTION 'Initial supplier cost posting must recognize the confirmed purchase amount';
    END IF;
  ELSIF entry.source_type = 'supplier_refund' THEN
    IF NOT EXISTS (SELECT 1 FROM supplier_purchases WHERE id = source_row.supplier_purchase_id
      AND account_id = entry.account_id AND confirmed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Supplier refund requires a previously confirmed purchase';
    END IF;
  ELSIF entry.source_type = 'expense' THEN
    IF source_row.status <> 'CONFIRMED' THEN RAISE EXCEPTION 'Expense posting requires a confirmed expense'; END IF;
  ELSIF entry.source_type = 'adjustment' THEN
    IF source_row.status = 'DRAFT' OR source_row.id = entry.id THEN
      RAISE EXCEPTION 'Adjustments reference a different finalized entry';
    END IF;
  END IF;
  IF entry.source_type = 'bank_withdrawal' THEN
    IF entry.currency <> 'PKR' OR debits <> source_row.actual_pkr_received THEN
      RAISE EXCEPTION 'Bank source posts only the actual PKR receipt; Payoneer owns USD principal and fee events';
    END IF;
  END IF;
  IF entry.source_type = 'payoneer_transaction' THEN
    IF source_row.transaction_type = 'WITHDRAWAL' AND entry.source_event = 'INITIAL' THEN
      IF EXISTS (SELECT 1 FROM journal_lines l JOIN financial_accounts a ON a.id = l.financial_account_id
        WHERE l.journal_entry_id = entry.id AND a.account_type = 'EXPENSE') THEN
        RAISE EXCEPTION 'Withdrawal principal is a transfer; post fees as a separate event';
      END IF;
    END IF;
  END IF;
  IF entry.source_event = 'INITIAL' AND entry.source_type = 'bank_withdrawal' THEN
    IF EXISTS (SELECT 1 FROM journal_lines l JOIN financial_accounts a ON a.id = l.financial_account_id
      WHERE l.journal_entry_id = entry.id AND a.account_type = 'EXPENSE') THEN
      RAISE EXCEPTION 'Withdrawal principal is a transfer; post fees as a separate event';
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_finalized_valid AFTER INSERT OR UPDATE ON journal_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_finalized_journal();
--> statement-breakpoint
CREATE FUNCTION guard_confirmed_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.confirmed_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Confirmed supplier purchases cannot be deleted'; END IF;
    IF (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at')
      OR NOT (NEW.status = OLD.status OR
        (OLD.status = 'CONFIRMED' AND NEW.status IN ('PARTIALLY_REFUNDED','REFUNDED')) OR
        (OLD.status = 'PARTIALLY_REFUNDED' AND NEW.status = 'REFUNDED')) THEN
      RAISE EXCEPTION 'Confirmed supplier purchase corrections require adjustments';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER supplier_purchase_immutable BEFORE INSERT OR UPDATE OR DELETE ON supplier_purchases
FOR EACH ROW EXECUTE FUNCTION guard_confirmed_purchase();
--> statement-breakpoint
CREATE FUNCTION guard_purchase_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purchase supplier_purchases;
BEGIN
  FOR purchase IN SELECT * FROM supplier_purchases
    WHERE id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.supplier_purchase_id END,
                 CASE WHEN TG_OP <> 'DELETE' THEN NEW.supplier_purchase_id END)
    ORDER BY id FOR UPDATE
  LOOP
    IF purchase.confirmed_at IS NOT NULL THEN RAISE EXCEPTION 'Confirmed supplier purchase items are immutable'; END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER supplier_purchase_item_immutable BEFORE INSERT OR UPDATE OR DELETE ON supplier_purchase_items
FOR EACH ROW EXECUTE FUNCTION guard_purchase_item();
--> statement-breakpoint
CREATE FUNCTION validate_purchase_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purchase supplier_purchases;
BEGIN
  SELECT * INTO purchase FROM supplier_purchases WHERE id = NEW.id;
  IF NOT FOUND OR purchase.confirmed_at IS NULL THEN RETURN NULL; END IF;
  IF purchase.total_amount > 0 AND NOT EXISTS (SELECT 1 FROM journal_entries WHERE account_id = purchase.account_id
    AND source_type = 'supplier_purchase' AND source_id = purchase.id AND source_event = 'INITIAL'
    AND currency = purchase.currency AND status = 'FINALIZED') THEN
    RAISE EXCEPTION 'Supplier confirmation and its finalized initial journal must commit atomically';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_purchase_items WHERE supplier_purchase_id = purchase.id)
    OR (SELECT sum(total_cost) FROM supplier_purchase_items WHERE supplier_purchase_id = purchase.id) <> purchase.total_amount THEN
    RAISE EXCEPTION 'Confirmed purchase items must sum to the purchase total';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER supplier_confirmation_valid AFTER INSERT OR UPDATE ON supplier_purchases
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_confirmation();
--> statement-breakpoint
-- Serialize related writes per tenant before deferred aggregate validation. This
-- deliberately favors correctness over write concurrency for this small SaaS.
CREATE FUNCTION lock_financial_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'Business records cannot change tenant';
  END IF;
  PERFORM 1 FROM business_accounts WHERE id IN
    (CASE WHEN TG_OP <> 'INSERT' THEN OLD.account_id END,
     CASE WHEN TG_OP <> 'DELETE' THEN NEW.account_id END) ORDER BY id FOR UPDATE;
  UPDATE business_accounts SET updated_at = updated_at
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.account_id ELSE NEW.account_id END;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION validate_financial_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid;
BEGIN
  -- Tenant ownership cannot be moved through UPDATE (see the lock trigger).
  tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD.account_id ELSE NEW.account_id END;
  IF EXISTS (SELECT 1 FROM payout_batches b WHERE b.account_id = tenant AND
    (SELECT coalesce(sum(i.expected_amount),0) FROM payout_batch_items i WHERE i.payout_batch_id = b.id) <> b.expected_total_amount) THEN
    RAISE EXCEPTION 'Expected payout total must equal its item amounts';
  END IF;
  IF EXISTS (SELECT 1 FROM etsy_payouts p WHERE p.account_id = tenant AND
    (SELECT coalesce(sum(a.allocated_amount),0) FROM etsy_payout_allocations a
     WHERE a.account_id = tenant AND a.etsy_payout_id = p.id) > p.actual_amount) THEN
    RAISE EXCEPTION 'Etsy allocations exceed actual payout';
  END IF;
  IF EXISTS (SELECT 1 FROM payout_batch_items i WHERE i.account_id = tenant AND
    (SELECT coalesce(sum(a.allocated_amount),0) FROM etsy_payout_allocations a
     WHERE a.account_id = tenant AND a.payout_batch_item_id = i.id) > i.expected_amount) THEN
    RAISE EXCEPTION 'Etsy allocation exceeds expected item; record an explicit adjustment first';
  END IF;
  IF EXISTS (SELECT 1 FROM payoneer_reconciliations r JOIN payoneer_transactions p
    ON p.id = r.payoneer_transaction_id AND p.account_id = r.account_id
    WHERE r.account_id = tenant AND p.transaction_type <> 'DEPOSIT') THEN
    RAISE EXCEPTION 'Reconciliation must reference a deposit';
  END IF;
  IF EXISTS (SELECT 1 FROM payoneer_transactions p WHERE p.account_id = tenant AND
    (SELECT coalesce(sum(r.allocated_amount),0) FROM payoneer_reconciliations r
     WHERE r.account_id = tenant AND r.payoneer_transaction_id = p.id AND r.status = 'CONFIRMED') > p.amount)
    OR EXISTS (SELECT 1 FROM etsy_payouts p WHERE p.account_id = tenant AND
    (SELECT coalesce(sum(r.allocated_amount),0) FROM payoneer_reconciliations r
     WHERE r.account_id = tenant AND r.etsy_payout_id = p.id AND r.status = 'CONFIRMED') > p.actual_amount) THEN
    RAISE EXCEPTION 'Confirmed reconciliation exceeds deposit or payout';
  END IF;
  IF EXISTS (SELECT 1 FROM bank_withdrawals w JOIN payoneer_transactions p
    ON p.id = w.payoneer_transaction_id AND p.account_id = w.account_id
    WHERE w.account_id = tenant AND (p.transaction_type <> 'WITHDRAWAL' OR p.currency <> 'USD' OR p.amount <> w.usd_amount)) THEN
    RAISE EXCEPTION 'Bank withdrawal must match a USD withdrawal transaction and principal amount';
  END IF;
  IF EXISTS (SELECT 1 FROM expense_allocations a JOIN expenses e ON e.id = a.expense_id AND e.account_id = a.account_id
    WHERE a.account_id = tenant AND (e.expense_type <> 'SHARED' OR e.status <> 'CONFIRMED')) THEN
    RAISE EXCEPTION 'Only confirmed shared expenses may be analytically allocated';
  END IF;
  IF EXISTS (SELECT 1 FROM expense_allocations a JOIN expenses e ON e.id = a.expense_id AND e.account_id = a.account_id
    WHERE a.account_id = tenant GROUP BY a.expense_id, a.reporting_period_start, a.reporting_period_end, a.allocation_method, e.amount
    HAVING sum(a.allocated_amount) > e.amount) THEN
    RAISE EXCEPTION 'Analytical scenario exceeds actual expense';
  END IF;
  IF EXISTS (SELECT i.order_id FROM payout_batch_items i JOIN payout_batches b
    ON b.id = i.payout_batch_id AND b.account_id = i.account_id
    WHERE i.account_id = tenant AND b.status <> 'CANCELLED' GROUP BY i.order_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'An order cannot appear in multiple active payout batches';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_posted_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_kind text := TG_ARGV[0];
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries WHERE account_id = OLD.account_id AND source_type = source_kind
    AND source_id = OLD.id AND status <> 'DRAFT') THEN
    -- Ordinary order lifecycle metadata may change; financial facts may not.
    IF TG_TABLE_NAME <> 'orders' OR TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Posted financial sources are immutable; create an adjustment';
    END IF;
    IF ROW(NEW.account_id, NEW.order_date, NEW.net_payable_amount, NEW.currency, NEW.etsy_order_id)
      IS DISTINCT FROM ROW(OLD.account_id, OLD.order_date, OLD.net_payable_amount, OLD.currency, OLD.etsy_order_id) THEN
      RAISE EXCEPTION 'Posted order financial facts are immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_financial_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.account_id, OLD.currency, OLD.account_type) IS DISTINCT FROM ROW(NEW.account_id, NEW.currency, NEW.account_type)
    AND EXISTS (SELECT 1 FROM journal_lines WHERE financial_account_id = OLD.id) THEN
    RAISE EXCEPTION 'Used ledger account denomination and type are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER financial_account_integrity BEFORE UPDATE ON financial_accounts
FOR EACH ROW EXECUTE FUNCTION guard_financial_account();

--> statement-breakpoint
CREATE TRIGGER a_lock_etsy_payouts BEFORE INSERT OR UPDATE OR DELETE ON etsy_payouts
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER validate_etsy_payouts AFTER INSERT OR UPDATE OR DELETE ON etsy_payouts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_financial_allocations();

--> statement-breakpoint
CREATE TRIGGER a_lock_etsy_payout_allocations BEFORE INSERT OR UPDATE OR DELETE ON etsy_payout_allocations
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER validate_etsy_payout_allocations AFTER INSERT OR UPDATE OR DELETE ON etsy_payout_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_financial_allocations();

--> statement-breakpoint
CREATE TRIGGER a_lock_payout_batches BEFORE INSERT OR UPDATE OR DELETE ON payout_batches
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER validate_payout_batches AFTER INSERT OR UPDATE OR DELETE ON payout_batches
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_financial_allocations();

--> statement-breakpoint
CREATE TRIGGER a_lock_payout_batch_items BEFORE INSERT OR UPDATE OR DELETE ON payout_batch_items
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER validate_payout_batch_items AFTER INSERT OR UPDATE OR DELETE ON payout_batch_items
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_financial_allocations();

--> statement-breakpoint
CREATE TRIGGER a_lock_payoneer_transactions BEFORE INSERT OR UPDATE OR DELETE ON payoneer_transactions
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER validate_payoneer_transactions AFTER INSERT OR UPDATE OR DELETE ON payoneer_transactions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_financial_allocations();

--> statement-breakpoint
CREATE TRIGGER a_lock_payoneer_reconciliations BEFORE INSERT OR UPDATE OR DELETE ON payoneer_reconciliations
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER validate_payoneer_reconciliations AFTER INSERT OR UPDATE OR DELETE ON payoneer_reconciliations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_financial_allocations();

--> statement-breakpoint
CREATE TRIGGER a_lock_bank_withdrawals BEFORE INSERT OR UPDATE OR DELETE ON bank_withdrawals
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER validate_bank_withdrawals AFTER INSERT OR UPDATE OR DELETE ON bank_withdrawals
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_financial_allocations();

--> statement-breakpoint
CREATE TRIGGER a_lock_expenses BEFORE INSERT OR UPDATE OR DELETE ON expenses
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER validate_expenses AFTER INSERT OR UPDATE OR DELETE ON expenses
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_financial_allocations();

--> statement-breakpoint
CREATE TRIGGER a_lock_expense_allocations BEFORE INSERT OR UPDATE OR DELETE ON expense_allocations
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER validate_expense_allocations AFTER INSERT OR UPDATE OR DELETE ON expense_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_financial_allocations();

--> statement-breakpoint
CREATE TRIGGER posted_orders_immutable BEFORE UPDATE OR DELETE ON orders
FOR EACH ROW EXECUTE FUNCTION guard_posted_source('order');

--> statement-breakpoint
CREATE TRIGGER posted_supplier_refunds_immutable BEFORE UPDATE OR DELETE ON supplier_refunds
FOR EACH ROW EXECUTE FUNCTION guard_posted_source('supplier_refund');

--> statement-breakpoint
CREATE TRIGGER posted_expenses_immutable BEFORE UPDATE OR DELETE ON expenses
FOR EACH ROW EXECUTE FUNCTION guard_posted_source('expense');

--> statement-breakpoint
CREATE TRIGGER posted_refunds_immutable BEFORE UPDATE OR DELETE ON refunds
FOR EACH ROW EXECUTE FUNCTION guard_posted_source('refund');

--> statement-breakpoint
CREATE TRIGGER posted_refund_adjustments_immutable BEFORE UPDATE OR DELETE ON refund_adjustments
FOR EACH ROW EXECUTE FUNCTION guard_posted_source('refund_adjustment');

--> statement-breakpoint
CREATE TRIGGER posted_etsy_payouts_immutable BEFORE UPDATE OR DELETE ON etsy_payouts
FOR EACH ROW EXECUTE FUNCTION guard_posted_source('etsy_payout');

--> statement-breakpoint
CREATE TRIGGER posted_payoneer_transactions_immutable BEFORE UPDATE OR DELETE ON payoneer_transactions
FOR EACH ROW EXECUTE FUNCTION guard_posted_source('payoneer_transaction');

--> statement-breakpoint
CREATE TRIGGER posted_bank_withdrawals_immutable BEFORE UPDATE OR DELETE ON bank_withdrawals
FOR EACH ROW EXECUTE FUNCTION guard_posted_source('bank_withdrawal');

-- Use the same tenant lock for ledger/source/account writes, so source guards
-- and ledger account classification cannot race an uncommitted finalization.

--> statement-breakpoint
CREATE TRIGGER a_lock_journal_entries BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();

--> statement-breakpoint
CREATE TRIGGER a_lock_journal_lines BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();

--> statement-breakpoint
CREATE TRIGGER a_lock_supplier_purchases BEFORE INSERT OR UPDATE OR DELETE ON supplier_purchases
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();

--> statement-breakpoint
CREATE TRIGGER a_lock_supplier_purchase_items BEFORE INSERT OR UPDATE OR DELETE ON supplier_purchase_items
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();

--> statement-breakpoint
CREATE TRIGGER a_lock_financial_accounts BEFORE INSERT OR UPDATE OR DELETE ON financial_accounts
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();

--> statement-breakpoint
CREATE TRIGGER a_lock_orders BEFORE INSERT OR UPDATE OR DELETE ON orders
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();

--> statement-breakpoint
CREATE TRIGGER a_lock_refunds BEFORE INSERT OR UPDATE OR DELETE ON refunds
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();

--> statement-breakpoint
CREATE TRIGGER a_lock_supplier_refunds BEFORE INSERT OR UPDATE OR DELETE ON supplier_refunds
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();

--> statement-breakpoint
CREATE TRIGGER a_lock_refund_adjustments BEFORE INSERT OR UPDATE OR DELETE ON refund_adjustments
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();

-- Forward-only overrides/extensions to 0001. See docs/Financial_Posting_Rules.md.
CREATE OR REPLACE FUNCTION guard_journal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Finalized/reversed journal entries are immutable; create an adjustment';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.status = 'REVERSED' THEN
    RAISE EXCEPTION 'REVERSED is legacy-only; create a separate FINALIZED reversal';
  END IF;
  IF NEW.source_event = 'REVERSAL' AND NEW.reversal_of_entry_id IS NULL THEN
    RAISE EXCEPTION 'A reversal requires an original journal reference';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION assert_standard_posting(entry_id uuid, expected numeric,
  debit_roles text[], credit_roles text[], debit_types text[], credit_types text[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF expected IS NULL OR expected <= 0 OR expected >= 'Infinity'::numeric THEN
    RAISE EXCEPTION 'Standard posting needs a positive finite source amount';
  END IF;
  IF (SELECT sum(debit_amount) FROM journal_lines WHERE journal_entry_id = entry_id) IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Journal amount differs from source amount';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_lines l JOIN financial_accounts a
    ON a.account_id = l.account_id AND a.id = l.financial_account_id
    WHERE l.journal_entry_id = entry_id AND
      ((l.debit_amount > 0 AND NOT ((debit_roles IS NULL OR a.account_role::text = ANY(debit_roles))
        AND a.account_type::text = ANY(debit_types))) OR
       (l.credit_amount > 0 AND NOT ((credit_roles IS NULL OR a.account_role::text = ANY(credit_roles))
        AND a.account_type::text = ANY(credit_types))))) THEN
    RAISE EXCEPTION 'Journal debit/credit accounts do not match the source posting rule';
  END IF;
  IF EXISTS (SELECT financial_account_id FROM journal_lines WHERE journal_entry_id = entry_id
    GROUP BY financial_account_id HAVING sum(debit_amount) > 0 AND sum(credit_amount) > 0) THEN
    RAISE EXCEPTION 'A standard movement cannot debit and credit the same account';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION validate_declared_posting(entry journal_entries, expected_source_amount numeric)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE declaration financial_posting_events; leg_count bigint; debits numeric; credits numeric; basis_amount numeric;
BEGIN
  SELECT * INTO declaration FROM financial_posting_events
    WHERE id = entry.posting_event_id AND account_id = entry.account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This source requires explicit posting instructions'; END IF;
  IF ROW(declaration.source_type, declaration.source_id, declaration.source_event, declaration.currency, declaration.event_key)
    IS DISTINCT FROM ROW(entry.source_type, entry.source_id, entry.source_event, entry.currency, entry.idempotency_key) THEN
    RAISE EXCEPTION 'Posting declaration identity must exactly match the journal';
  END IF;
  IF expected_source_amount IS NOT NULL AND declaration.source_amount IS DISTINCT FROM expected_source_amount THEN
    RAISE EXCEPTION 'Declared amount differs from the source amount';
  END IF;
  SELECT count(*), sum(debit_amount), sum(credit_amount) INTO leg_count, debits, credits
    FROM financial_posting_legs WHERE posting_event_id = declaration.id AND account_id = entry.account_id;
  IF leg_count < 2 OR debits IS DISTINCT FROM credits OR debits <= 0 THEN
    RAISE EXCEPTION 'Explicit posting instructions must contain balanced nonzero legs';
  END IF;
  IF declaration.amount_basis = 'TOTAL_DEBITS' THEN basis_amount := debits;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM financial_posting_legs WHERE posting_event_id = declaration.id
      AND financial_account_id = declaration.control_financial_account_id) THEN
      RAISE EXCEPTION 'Declared control account must occur in the posting legs';
    END IF;
    SELECT sum(debit_amount - credit_amount) INTO basis_amount FROM financial_posting_legs
      WHERE posting_event_id = declaration.id AND financial_account_id = declaration.control_financial_account_id;
    IF declaration.amount_basis = 'NET_CREDIT' THEN basis_amount := -basis_amount; END IF;
  END IF;
  IF basis_amount IS DISTINCT FROM declaration.source_amount THEN
    RAISE EXCEPTION 'Explicit legs must match the declared source amount and amount basis';
  END IF;
  -- Compare multisets rather than netting: no hidden wash lines or extra duplicates.
  IF EXISTS ((SELECT financial_account_id, debit_amount, credit_amount, currency FROM journal_lines WHERE journal_entry_id = entry.id
    EXCEPT ALL SELECT financial_account_id, debit_amount, credit_amount, currency FROM financial_posting_legs WHERE posting_event_id = declaration.id)
    UNION ALL (SELECT financial_account_id, debit_amount, credit_amount, currency FROM financial_posting_legs WHERE posting_event_id = declaration.id
    EXCEPT ALL SELECT financial_account_id, debit_amount, credit_amount, currency FROM journal_lines WHERE journal_entry_id = entry.id)) THEN
    RAISE EXCEPTION 'Journal lines must exactly match explicit posting legs';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_finalized_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry journal_entries; original journal_entries; line_count bigint; debits numeric; credits numeric;
  source_row record; source_table text; is_declared boolean := false;
BEGIN
  SELECT * INTO entry FROM journal_entries WHERE id = NEW.id;
  IF NOT FOUND OR entry.status = 'DRAFT' THEN RETURN NULL; END IF;
  SELECT count(*), sum(debit_amount), sum(credit_amount) INTO line_count, debits, credits
    FROM journal_lines WHERE account_id = entry.account_id AND journal_entry_id = entry.id;
  IF line_count < 2 OR debits IS DISTINCT FROM credits OR debits <= 0 THEN
    RAISE EXCEPTION 'Finalized journal must have at least two nonzero balanced lines';
  END IF;
  IF entry.reversal_of_entry_id IS NOT NULL THEN
    SELECT * INTO original FROM journal_entries WHERE account_id = entry.account_id AND id = entry.reversal_of_entry_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reversal original is missing'; END IF;
    IF original.id = entry.id OR original.status <> 'FINALIZED' OR original.reversal_of_entry_id IS NOT NULL
      OR original.source_event = 'REVERSAL' OR original.currency <> entry.currency OR entry.posting_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'Reverse only an original finalized same-currency entry; reversal chains are forbidden';
    END IF;
    IF EXISTS ((SELECT financial_account_id, debit_amount, credit_amount, currency FROM journal_lines WHERE journal_entry_id = entry.id
      EXCEPT ALL SELECT financial_account_id, credit_amount, debit_amount, currency FROM journal_lines WHERE journal_entry_id = original.id)
      UNION ALL (SELECT financial_account_id, credit_amount, debit_amount, currency FROM journal_lines WHERE journal_entry_id = original.id
      EXCEPT ALL SELECT financial_account_id, debit_amount, credit_amount, currency FROM journal_lines WHERE journal_entry_id = entry.id)) THEN
      RAISE EXCEPTION 'A reversal must exactly offset every original journal line';
    END IF;
    RETURN NULL;
  END IF;
  source_table := CASE entry.source_type
    WHEN 'order' THEN 'orders' WHEN 'supplier_purchase' THEN 'supplier_purchases'
    WHEN 'supplier_refund' THEN 'supplier_refunds' WHEN 'expense' THEN 'expenses'
    WHEN 'refund' THEN 'refunds' WHEN 'refund_adjustment' THEN 'refund_adjustments'
    WHEN 'etsy_payout' THEN 'etsy_payouts' WHEN 'payoneer_transaction' THEN 'payoneer_transactions'
    WHEN 'bank_withdrawal' THEN 'bank_withdrawals' WHEN 'adjustment' THEN 'journal_entries'
    WHEN 'opening_balance' THEN 'financial_accounts' ELSE NULL END;
  IF source_table IS NULL THEN RAISE EXCEPTION 'Unsupported financial source: %', entry.source_type; END IF;
  IF entry.source_type <> 'adjustment' AND entry.source_event <> 'INITIAL'
    AND NOT (entry.source_type = 'payoneer_transaction' AND entry.source_event = 'FEE') THEN
    RAISE EXCEPTION 'Invalid source event';
  END IF;
  IF entry.source_event = 'REVERSAL' THEN RAISE EXCEPTION 'Reversal original reference required'; END IF;
  EXECUTE format('SELECT * FROM %I WHERE account_id = $1 AND id = $2 FOR UPDATE', source_table)
    INTO source_row USING entry.account_id, entry.source_id;
  IF source_row IS NULL THEN RAISE EXCEPTION 'Journal source must exist in the same tenant'; END IF;
  IF entry.source_type = 'bank_withdrawal' THEN
    IF entry.currency <> 'PKR' THEN RAISE EXCEPTION 'Bank source must use actual PKR receipt'; END IF;
  ELSIF entry.source_type = 'payoneer_transaction' AND entry.source_event = 'FEE' THEN
    IF source_row.fee_currency IS DISTINCT FROM entry.currency THEN RAISE EXCEPTION 'Fee currency mismatch'; END IF;
  ELSE
    IF source_row.currency <> entry.currency THEN RAISE EXCEPTION 'Journal/source currency mismatch'; END IF;
  END IF;
  CASE entry.source_type
    WHEN 'order' THEN
      PERFORM assert_standard_posting(entry.id, source_row.net_payable_amount, ARRAY['ETSY_RECEIVABLE'], ARRAY['REVENUE'], ARRAY['ASSET'], ARRAY['INCOME']);
    WHEN 'supplier_purchase' THEN
      IF source_row.confirmed_at IS NULL OR source_row.status NOT IN ('CONFIRMED','PARTIALLY_REFUNDED','REFUNDED') THEN
        RAISE EXCEPTION 'Supplier costs require a confirmed purchase';
      END IF;
      PERFORM assert_standard_posting(entry.id, source_row.total_amount, ARRAY['SUPPLIER_COST'], NULL, ARRAY['EXPENSE'], ARRAY['ASSET','LIABILITY']);
    WHEN 'supplier_refund' THEN
      IF NOT EXISTS (SELECT 1 FROM supplier_purchases WHERE id = source_row.supplier_purchase_id
        AND account_id = entry.account_id AND confirmed_at IS NOT NULL) THEN RAISE EXCEPTION 'Supplier refund requires a confirmed purchase'; END IF;
      PERFORM assert_standard_posting(entry.id, source_row.refund_amount, NULL, ARRAY['SUPPLIER_COST'], ARRAY['ASSET'], ARRAY['EXPENSE']);
    WHEN 'expense' THEN
      IF source_row.status <> 'CONFIRMED' THEN RAISE EXCEPTION 'Expense posting requires confirmation'; END IF;
      PERFORM assert_standard_posting(entry.id, source_row.amount,
        ARRAY[CASE WHEN source_row.expense_type = 'DIRECT' THEN 'DIRECT_EXPENSE' ELSE 'SHARED_EXPENSE' END], NULL, ARRAY['EXPENSE'], ARRAY['ASSET','LIABILITY']);
    WHEN 'refund' THEN
      PERFORM assert_standard_posting(entry.id, source_row.refund_amount, ARRAY['REFUND'], NULL, ARRAY['INCOME','EXPENSE'], ARRAY['ASSET','LIABILITY']);
    WHEN 'refund_adjustment' THEN
      is_declared := true;
      PERFORM validate_declared_posting(entry, source_row.amount);
    WHEN 'etsy_payout' THEN
      PERFORM assert_standard_posting(entry.id, source_row.actual_amount, ARRAY['ETSY_PAYOUT_CLEARING'], ARRAY['ETSY_RECEIVABLE'], ARRAY['ASSET'], ARRAY['ASSET']);
    WHEN 'payoneer_transaction' THEN
      IF entry.source_event = 'FEE' THEN
        IF source_row.transaction_type = 'FEE' THEN RAISE EXCEPTION 'Standalone fee cannot also carry an embedded fee event'; END IF;
        PERFORM assert_standard_posting(entry.id, source_row.fee_amount, ARRAY['SHARED_EXPENSE'], ARRAY['PAYONEER'], ARRAY['EXPENSE'], ARRAY['ASSET']);
      ELSE
        CASE source_row.transaction_type
          WHEN 'DEPOSIT' THEN
            PERFORM assert_standard_posting(entry.id, source_row.amount, ARRAY['PAYONEER'], ARRAY['ETSY_PAYOUT_CLEARING'], ARRAY['ASSET'], ARRAY['ASSET']);
          WHEN 'WITHDRAWAL' THEN
            PERFORM assert_standard_posting(entry.id, source_row.amount, ARRAY['TRANSFER_CLEARING'], ARRAY['PAYONEER'], ARRAY['ASSET'], ARRAY['ASSET']);
          WHEN 'FEE' THEN
            IF coalesce(source_row.fee_amount,0) <> 0 THEN RAISE EXCEPTION 'Standalone fee must not duplicate embedded fees'; END IF;
            PERFORM assert_standard_posting(entry.id, source_row.amount, ARRAY['SHARED_EXPENSE'], ARRAY['PAYONEER'], ARRAY['EXPENSE'], ARRAY['ASSET']);
          WHEN 'ADJUSTMENT', 'OTHER' THEN
            is_declared := true;
            PERFORM validate_declared_posting(entry, source_row.amount);
          ELSE RAISE EXCEPTION 'Unsupported Payoneer transaction type';
        END CASE;
      END IF;
    WHEN 'bank_withdrawal' THEN
      PERFORM assert_standard_posting(entry.id, source_row.actual_pkr_received, ARRAY['BANK'], ARRAY['TRANSFER_CLEARING'], ARRAY['ASSET'], ARRAY['ASSET']);
    WHEN 'adjustment' THEN
      IF source_row.id = entry.id OR source_row.status <> 'FINALIZED' THEN RAISE EXCEPTION 'Adjustment must reference a different finalized journal'; END IF;
      is_declared := true;
      PERFORM validate_declared_posting(entry, NULL);
    WHEN 'opening_balance' THEN
      is_declared := true;
      IF NOT EXISTS (SELECT 1 FROM financial_posting_events WHERE id = entry.posting_event_id
        AND amount_basis <> 'TOTAL_DEBITS' AND control_financial_account_id = entry.source_id) THEN
        RAISE EXCEPTION 'Opening balance must explicitly measure the source financial account net movement';
      END IF;
      PERFORM validate_declared_posting(entry, NULL);
    ELSE RAISE EXCEPTION 'Unsupported source';
  END CASE;
  IF NOT is_declared AND entry.posting_event_id IS NOT NULL THEN RAISE EXCEPTION 'Standard events cannot override predefined legs'; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Atomic reversal creation: preserve original rows/status and copy opposite lines.
CREATE FUNCTION reverse_journal_entry(tenant uuid, original_id uuid, event_key text, reversed_at timestamptz)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE original journal_entries; reversal_id uuid;
BEGIN
  IF event_key IS NULL OR length(trim(event_key)) = 0 OR reversed_at IS NULL THEN RAISE EXCEPTION 'Reversal event key/date required'; END IF;
  PERFORM 1 FROM business_accounts WHERE id = tenant FOR UPDATE;
  SELECT * INTO original FROM journal_entries WHERE account_id = tenant AND id = original_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original journal does not exist for tenant'; END IF;
  IF original.status <> 'FINALIZED' OR original.reversal_of_entry_id IS NOT NULL OR original.source_event = 'REVERSAL' THEN
    RAISE EXCEPTION 'Only original finalized journals can be reversed';
  END IF;
  SELECT id INTO reversal_id FROM journal_entries WHERE account_id = tenant AND reversal_of_entry_id = original_id;
  IF FOUND THEN
    IF EXISTS (SELECT 1 FROM journal_entries WHERE id = reversal_id AND idempotency_key = event_key AND status = 'FINALIZED') THEN RETURN reversal_id; END IF;
    RAISE EXCEPTION 'Original journal already has a reversal';
  END IF;
  INSERT INTO journal_entries(account_id, source_type, source_id, source_event, currency, transaction_date, idempotency_key, reversal_of_entry_id)
    VALUES(tenant, 'adjustment', original_id, 'REVERSAL', original.currency, reversed_at, event_key, original_id) RETURNING id INTO reversal_id;
  INSERT INTO journal_lines(account_id, journal_entry_id, financial_account_id, debit_amount, credit_amount, currency)
    SELECT account_id, reversal_id, financial_account_id, credit_amount, debit_amount, currency FROM journal_lines WHERE journal_entry_id = original_id;
  UPDATE journal_entries SET status = 'FINALIZED', finalized_at = reversed_at WHERE id = reversal_id;
  -- Deferred validation runs at the caller's transaction boundary.
  RETURN reversal_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_posting_instructions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_ids uuid[];
BEGIN
  IF TG_TABLE_NAME = 'financial_posting_events' THEN
    event_ids := ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.id END];
  ELSE
    event_ids := ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.posting_event_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.posting_event_id END];
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries WHERE posting_event_id = ANY(event_ids) AND status <> 'DRAFT') THEN
    RAISE EXCEPTION 'Finalized posting instructions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_financial_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (ROW(OLD.account_id, OLD.currency, OLD.account_type) IS DISTINCT FROM ROW(NEW.account_id, NEW.currency, NEW.account_type)
      OR (OLD.account_role <> 'UNCLASSIFIED' AND OLD.account_role <> NEW.account_role))
    AND (EXISTS (SELECT 1 FROM journal_lines WHERE financial_account_id = OLD.id)
      OR EXISTS (SELECT 1 FROM financial_posting_legs WHERE financial_account_id = OLD.id)) THEN
    RAISE EXCEPTION 'Used financial account denomination, type and classified role are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_lock_posting_events BEFORE INSERT OR UPDATE OR DELETE ON financial_posting_events
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE TRIGGER a_lock_posting_legs BEFORE INSERT OR UPDATE OR DELETE ON financial_posting_legs
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE TRIGGER posting_events_immutable BEFORE UPDATE OR DELETE ON financial_posting_events
FOR EACH ROW EXECUTE FUNCTION guard_posting_instructions();
--> statement-breakpoint
CREATE TRIGGER posting_legs_immutable BEFORE INSERT OR UPDATE OR DELETE ON financial_posting_legs
FOR EACH ROW EXECUTE FUNCTION guard_posting_instructions();

-- Reject new generic adjustments against effectively reversed originals. No exceptions are permitted.
CREATE OR REPLACE FUNCTION validate_finalized_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry journal_entries; original journal_entries; line_count bigint; debits numeric; credits numeric;
  source_row record; source_table text; is_declared boolean := false;
BEGIN
  SELECT * INTO entry FROM journal_entries WHERE id = NEW.id;
  IF NOT FOUND OR entry.status = 'DRAFT' THEN RETURN NULL; END IF;
  SELECT count(*), sum(debit_amount), sum(credit_amount) INTO line_count, debits, credits
    FROM journal_lines WHERE account_id = entry.account_id AND journal_entry_id = entry.id;
  IF line_count < 2 OR debits IS DISTINCT FROM credits OR debits <= 0 THEN
    RAISE EXCEPTION 'Finalized journal must have at least two nonzero balanced lines';
  END IF;
  IF entry.reversal_of_entry_id IS NOT NULL THEN
    SELECT * INTO original FROM journal_entries WHERE account_id = entry.account_id AND id = entry.reversal_of_entry_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reversal original is missing'; END IF;
    IF original.id = entry.id OR original.status <> 'FINALIZED' OR original.reversal_of_entry_id IS NOT NULL
      OR original.source_event = 'REVERSAL' OR original.currency <> entry.currency OR entry.posting_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'Reverse only an original finalized same-currency entry; reversal chains are forbidden';
    END IF;
    IF EXISTS ((SELECT financial_account_id, debit_amount, credit_amount, currency FROM journal_lines WHERE journal_entry_id = entry.id
      EXCEPT ALL SELECT financial_account_id, credit_amount, debit_amount, currency FROM journal_lines WHERE journal_entry_id = original.id)
      UNION ALL (SELECT financial_account_id, credit_amount, debit_amount, currency FROM journal_lines WHERE journal_entry_id = original.id
      EXCEPT ALL SELECT financial_account_id, debit_amount, credit_amount, currency FROM journal_lines WHERE journal_entry_id = entry.id)) THEN
      RAISE EXCEPTION 'A reversal must exactly offset every original journal line';
    END IF;
    RETURN NULL;
  END IF;
  source_table := CASE entry.source_type
    WHEN 'order' THEN 'orders' WHEN 'supplier_purchase' THEN 'supplier_purchases'
    WHEN 'supplier_refund' THEN 'supplier_refunds' WHEN 'expense' THEN 'expenses'
    WHEN 'refund' THEN 'refunds' WHEN 'refund_adjustment' THEN 'refund_adjustments'
    WHEN 'etsy_payout' THEN 'etsy_payouts' WHEN 'payoneer_transaction' THEN 'payoneer_transactions'
    WHEN 'bank_withdrawal' THEN 'bank_withdrawals' WHEN 'adjustment' THEN 'journal_entries'
    WHEN 'opening_balance' THEN 'financial_accounts' ELSE NULL END;
  IF source_table IS NULL THEN RAISE EXCEPTION 'Unsupported financial source: %', entry.source_type; END IF;
  IF entry.source_type <> 'adjustment' AND entry.source_event <> 'INITIAL'
    AND NOT (entry.source_type = 'payoneer_transaction' AND entry.source_event = 'FEE') THEN
    RAISE EXCEPTION 'Invalid source event';
  END IF;
  IF entry.source_event = 'REVERSAL' THEN RAISE EXCEPTION 'Reversal original reference required'; END IF;
  EXECUTE format('SELECT * FROM %I WHERE account_id = $1 AND id = $2 FOR UPDATE', source_table)
    INTO source_row USING entry.account_id, entry.source_id;
  IF source_row IS NULL THEN RAISE EXCEPTION 'Journal source must exist in the same tenant'; END IF;
  IF entry.source_type = 'bank_withdrawal' THEN
    IF entry.currency <> 'PKR' THEN RAISE EXCEPTION 'Bank source must use actual PKR receipt'; END IF;
  ELSIF entry.source_type = 'payoneer_transaction' AND entry.source_event = 'FEE' THEN
    IF source_row.fee_currency IS DISTINCT FROM entry.currency THEN RAISE EXCEPTION 'Fee currency mismatch'; END IF;
  ELSE
    IF source_row.currency <> entry.currency THEN RAISE EXCEPTION 'Journal/source currency mismatch'; END IF;
  END IF;
  CASE entry.source_type
    WHEN 'order' THEN
      PERFORM assert_standard_posting(entry.id, source_row.net_payable_amount, ARRAY['ETSY_RECEIVABLE'], ARRAY['REVENUE'], ARRAY['ASSET'], ARRAY['INCOME']);
    WHEN 'supplier_purchase' THEN
      IF source_row.confirmed_at IS NULL OR source_row.status NOT IN ('CONFIRMED','PARTIALLY_REFUNDED','REFUNDED') THEN
        RAISE EXCEPTION 'Supplier costs require a confirmed purchase';
      END IF;
      PERFORM assert_standard_posting(entry.id, source_row.total_amount, ARRAY['SUPPLIER_COST'], NULL, ARRAY['EXPENSE'], ARRAY['ASSET','LIABILITY']);
    WHEN 'supplier_refund' THEN
      IF NOT EXISTS (SELECT 1 FROM supplier_purchases WHERE id = source_row.supplier_purchase_id
        AND account_id = entry.account_id AND confirmed_at IS NOT NULL) THEN RAISE EXCEPTION 'Supplier refund requires a confirmed purchase'; END IF;
      PERFORM assert_standard_posting(entry.id, source_row.refund_amount, NULL, ARRAY['SUPPLIER_COST'], ARRAY['ASSET'], ARRAY['EXPENSE']);
    WHEN 'expense' THEN
      IF source_row.status <> 'CONFIRMED' THEN RAISE EXCEPTION 'Expense posting requires confirmation'; END IF;
      PERFORM assert_standard_posting(entry.id, source_row.amount,
        ARRAY[CASE WHEN source_row.expense_type = 'DIRECT' THEN 'DIRECT_EXPENSE' ELSE 'SHARED_EXPENSE' END], NULL, ARRAY['EXPENSE'], ARRAY['ASSET','LIABILITY']);
    WHEN 'refund' THEN
      PERFORM assert_standard_posting(entry.id, source_row.refund_amount, ARRAY['REFUND'], NULL, ARRAY['INCOME','EXPENSE'], ARRAY['ASSET','LIABILITY']);
    WHEN 'refund_adjustment' THEN
      is_declared := true;
      PERFORM validate_declared_posting(entry, source_row.amount);
    WHEN 'etsy_payout' THEN
      PERFORM assert_standard_posting(entry.id, source_row.actual_amount, ARRAY['ETSY_PAYOUT_CLEARING'], ARRAY['ETSY_RECEIVABLE'], ARRAY['ASSET'], ARRAY['ASSET']);
    WHEN 'payoneer_transaction' THEN
      IF entry.source_event = 'FEE' THEN
        IF source_row.transaction_type = 'FEE' THEN RAISE EXCEPTION 'Standalone fee cannot also carry an embedded fee event'; END IF;
        PERFORM assert_standard_posting(entry.id, source_row.fee_amount, ARRAY['SHARED_EXPENSE'], ARRAY['PAYONEER'], ARRAY['EXPENSE'], ARRAY['ASSET']);
      ELSE
        CASE source_row.transaction_type
          WHEN 'DEPOSIT' THEN
            PERFORM assert_standard_posting(entry.id, source_row.amount, ARRAY['PAYONEER'], ARRAY['ETSY_PAYOUT_CLEARING'], ARRAY['ASSET'], ARRAY['ASSET']);
          WHEN 'WITHDRAWAL' THEN
            PERFORM assert_standard_posting(entry.id, source_row.amount, ARRAY['TRANSFER_CLEARING'], ARRAY['PAYONEER'], ARRAY['ASSET'], ARRAY['ASSET']);
          WHEN 'FEE' THEN
            IF coalesce(source_row.fee_amount,0) <> 0 THEN RAISE EXCEPTION 'Standalone fee must not duplicate embedded fees'; END IF;
            PERFORM assert_standard_posting(entry.id, source_row.amount, ARRAY['SHARED_EXPENSE'], ARRAY['PAYONEER'], ARRAY['EXPENSE'], ARRAY['ASSET']);
          WHEN 'ADJUSTMENT', 'OTHER' THEN
            is_declared := true;
            PERFORM validate_declared_posting(entry, source_row.amount);
          ELSE RAISE EXCEPTION 'Unsupported Payoneer transaction type';
        END CASE;
      END IF;
    WHEN 'bank_withdrawal' THEN
      PERFORM assert_standard_posting(entry.id, source_row.actual_pkr_received, ARRAY['BANK'], ARRAY['TRANSFER_CLEARING'], ARRAY['ASSET'], ARRAY['ASSET']);
    WHEN 'adjustment' THEN
      IF source_row.id = entry.id OR source_row.status <> 'FINALIZED' THEN RAISE EXCEPTION 'Adjustment must reference a different finalized journal'; END IF;
      IF EXISTS (SELECT 1 FROM journal_entries reversal
        WHERE reversal.account_id = entry.account_id AND reversal.reversal_of_entry_id = source_row.id
          AND reversal.status = 'FINALIZED') THEN
        RAISE EXCEPTION 'Cannot adjust an original journal with a finalized reversal';
      END IF;
      is_declared := true;
      PERFORM validate_declared_posting(entry, NULL);
    WHEN 'opening_balance' THEN
      is_declared := true;
      IF NOT EXISTS (SELECT 1 FROM financial_posting_events WHERE id = entry.posting_event_id
        AND amount_basis <> 'TOTAL_DEBITS' AND control_financial_account_id = entry.source_id) THEN
        RAISE EXCEPTION 'Opening balance must explicitly measure the source financial account net movement';
      END IF;
      PERFORM validate_declared_posting(entry, NULL);
    ELSE RAISE EXCEPTION 'Unsupported source';
  END CASE;
  IF NOT is_declared AND entry.posting_event_id IS NOT NULL THEN RAISE EXCEPTION 'Standard events cannot override predefined legs'; END IF;
  RETURN NULL;
END $$;

-- Only deposits supply reconciliation capacity; signed adjustment/OTHER amounts are not deposits.
CREATE OR REPLACE FUNCTION validate_financial_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid;
BEGIN
  -- Tenant ownership cannot be moved through UPDATE (see the lock trigger).
  tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD.account_id ELSE NEW.account_id END;
  IF EXISTS (SELECT 1 FROM payout_batches b WHERE b.account_id = tenant AND
    (SELECT coalesce(sum(i.expected_amount),0) FROM payout_batch_items i WHERE i.payout_batch_id = b.id) <> b.expected_total_amount) THEN
    RAISE EXCEPTION 'Expected payout total must equal its item amounts';
  END IF;
  IF EXISTS (SELECT 1 FROM etsy_payouts p WHERE p.account_id = tenant AND
    (SELECT coalesce(sum(a.allocated_amount),0) FROM etsy_payout_allocations a
     WHERE a.account_id = tenant AND a.etsy_payout_id = p.id) > p.actual_amount) THEN
    RAISE EXCEPTION 'Etsy allocations exceed actual payout';
  END IF;
  IF EXISTS (SELECT 1 FROM payout_batch_items i WHERE i.account_id = tenant AND
    (SELECT coalesce(sum(a.allocated_amount),0) FROM etsy_payout_allocations a
     WHERE a.account_id = tenant AND a.payout_batch_item_id = i.id) > i.expected_amount) THEN
    RAISE EXCEPTION 'Etsy allocation exceeds expected item; record an explicit adjustment first';
  END IF;
  IF EXISTS (SELECT 1 FROM payoneer_reconciliations r JOIN payoneer_transactions p
    ON p.id = r.payoneer_transaction_id AND p.account_id = r.account_id
    WHERE r.account_id = tenant AND p.transaction_type <> 'DEPOSIT') THEN
    RAISE EXCEPTION 'Reconciliation must reference a deposit';
  END IF;
  IF EXISTS (SELECT 1 FROM payoneer_transactions p WHERE p.account_id = tenant AND p.transaction_type = 'DEPOSIT' AND
    (SELECT coalesce(sum(r.allocated_amount),0) FROM payoneer_reconciliations r
     WHERE r.account_id = tenant AND r.payoneer_transaction_id = p.id AND r.status = 'CONFIRMED') > p.amount)
    OR EXISTS (SELECT 1 FROM etsy_payouts p WHERE p.account_id = tenant AND
    (SELECT coalesce(sum(r.allocated_amount),0) FROM payoneer_reconciliations r
     WHERE r.account_id = tenant AND r.etsy_payout_id = p.id AND r.status = 'CONFIRMED') > p.actual_amount) THEN
    RAISE EXCEPTION 'Confirmed reconciliation exceeds deposit or payout';
  END IF;
  IF EXISTS (SELECT 1 FROM bank_withdrawals w JOIN payoneer_transactions p
    ON p.id = w.payoneer_transaction_id AND p.account_id = w.account_id
    WHERE w.account_id = tenant AND (p.transaction_type <> 'WITHDRAWAL' OR p.currency <> 'USD' OR p.amount <> w.usd_amount)) THEN
    RAISE EXCEPTION 'Bank withdrawal must match a USD withdrawal transaction and principal amount';
  END IF;
  IF EXISTS (SELECT 1 FROM expense_allocations a JOIN expenses e ON e.id = a.expense_id AND e.account_id = a.account_id
    WHERE a.account_id = tenant AND (e.expense_type <> 'SHARED' OR e.status <> 'CONFIRMED')) THEN
    RAISE EXCEPTION 'Only confirmed shared expenses may be analytically allocated';
  END IF;
  IF EXISTS (SELECT 1 FROM expense_allocations a JOIN expenses e ON e.id = a.expense_id AND e.account_id = a.account_id
    WHERE a.account_id = tenant GROUP BY a.expense_id, a.reporting_period_start, a.reporting_period_end, a.allocation_method, e.amount
    HAVING sum(a.allocated_amount) > e.amount) THEN
    RAISE EXCEPTION 'Analytical scenario exceeds actual expense';
  END IF;
  IF EXISTS (SELECT i.order_id FROM payout_batch_items i JOIN payout_batches b
    ON b.id = i.payout_batch_id AND b.account_id = i.account_id
    WHERE i.account_id = tenant AND b.status <> 'CANCELLED' GROUP BY i.order_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'An order cannot appear in multiple active payout batches';
  END IF;
  RETURN NULL;
END $$;
