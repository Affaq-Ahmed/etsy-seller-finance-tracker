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

--> statement-breakpoint
-- Status dates respect shipment creation; historical NOTE events remain valid.
CREATE OR REPLACE FUNCTION guard_shipment_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE shipment shipments; last_status_date timestamptz; allowed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Shipment events are append-only'; END IF;
  SELECT * INTO shipment FROM shipments WHERE account_id = NEW.account_id AND id = NEW.shipment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shipment event requires a same-tenant shipment'; END IF;
  IF NEW.event_type = 'NOTE' THEN RETURN NEW; END IF;
  IF NEW.event_date < shipment.created_at THEN
    RAISE EXCEPTION 'Shipment status event cannot precede shipment creation';
  END IF;
  IF NEW.event_type = 'PENDING' THEN
    IF pg_trigger_depth() < 2 OR EXISTS (SELECT 1 FROM shipment_events WHERE shipment_id = shipment.id) THEN
      RAISE EXCEPTION 'Only shipment creation may append the initial PENDING event';
    END IF;
    RETURN NEW;
  END IF;
  SELECT max(event_date) INTO last_status_date FROM shipment_events WHERE shipment_id = shipment.id AND event_type NOT IN ('PENDING','NOTE');
  IF last_status_date IS NOT NULL AND NEW.event_date < last_status_date THEN
    RAISE EXCEPTION 'Status events must be chronological; append a NOTE for historical observations';
  END IF;
  allowed := CASE shipment.shipment_status
    WHEN 'PENDING' THEN NEW.event_type IN ('SHIPPED','CANCELLED')
    WHEN 'SHIPPED' THEN NEW.event_type IN ('IN_TRANSIT','DELIVERED','EXCEPTION','RETURNED','CANCELLED')
    WHEN 'IN_TRANSIT' THEN NEW.event_type IN ('IN_TRANSIT','DELIVERED','EXCEPTION','RETURNED')
    WHEN 'EXCEPTION' THEN NEW.event_type IN ('IN_TRANSIT','DELIVERED','RETURNED','CANCELLED','EXCEPTION')
    WHEN 'DELIVERED' THEN NEW.event_type = 'RETURNED'
    ELSE false END;
  IF NOT allowed THEN RAISE EXCEPTION 'Invalid shipment status transition: % -> %', shipment.shipment_status, NEW.event_type; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_shipment_metadata_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.carrier, NEW.tracking_number, NEW.tracking_url, NEW.estimated_delivery_at, NEW.notes)
    IS DISTINCT FROM ROW(OLD.carrier, OLD.tracking_number, OLD.tracking_url, OLD.estimated_delivery_at, OLD.notes) THEN
    INSERT INTO shipment_events(account_id, shipment_id, event_type, event_date, description)
      VALUES(NEW.account_id, NEW.id, 'NOTE', clock_timestamp(), 'Manual shipment metadata updated');
    INSERT INTO audit_logs(account_id, entity_type, entity_id, action, before_data, after_data)
      VALUES(NEW.account_id, 'shipment', NEW.id, 'METADATA_UPDATED',
        jsonb_build_object('carrier',OLD.carrier,'tracking_number',OLD.tracking_number,'tracking_url',OLD.tracking_url,'estimated_delivery_at',OLD.estimated_delivery_at,'notes',OLD.notes),
        jsonb_build_object('carrier',NEW.carrier,'tracking_number',NEW.tracking_number,'tracking_url',NEW.tracking_url,'estimated_delivery_at',NEW.estimated_delivery_at,'notes',NEW.notes));
  END IF;
  RETURN NULL;
END $$;
