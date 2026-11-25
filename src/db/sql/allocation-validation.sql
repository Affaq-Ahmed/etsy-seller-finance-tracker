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
