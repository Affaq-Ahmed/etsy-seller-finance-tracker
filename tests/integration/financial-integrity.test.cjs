const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID: uuid } = require('node:crypto');
const postgres = require('postgres');

// Never load .env.local or fall back to the application/production DATABASE_URL.
const url = process.env.LOCAL_TEST_DATABASE_URL;
let sql;
if (url) {
  require('../helpers/local-database.cjs').validateLocalTestDatabase(url);
  sql = postgres(url, { max: 1, connect_timeout: 3, onnotice() {} });
}
after(async () => { if (sql) await sql.end({ timeout: 1 }); });
const rollback = new Error('rollback-test-fixture');
function integration(name, fn) {
  test(name, { skip: !url && 'No dedicated disposable local PostgreSQL configured' }, async () => {
    try {
      await sql.begin(async tx => {
        const f = await fixture(tx);
        await fn(tx, f);
        await tx.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
  });
}
function rejects(name, fn, pattern) {
  integration(name, async (tx, f) => {
    // SAVEPOINT permits asserting deferred failures and rolling back without
    // invalidating the fixture. Every candidate is checked before savepoint exit.
    await assert.rejects(tx.savepoint(async candidate => {
      await fn(candidate, f);
      await candidate.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), pattern);
  });
}
const { fixture, entry, orderPosting, confirmPurchase, payoneer, withdrawal, declared, shipment, shipEvent } = require('../helpers/financial-fixture.cjs');

integration('valid balanced order entry', async(tx,f)=>{ await orderPosting(tx,f); });
rejects('unbalanced entry rejected', (tx,f)=>orderPosting(tx,f,{creditAmount:'99'}), /balanced/);
rejects('balanced but incorrect source amount rejected', (tx,f)=>entry(tx,f,'order',f.order,'99',f.accounts.receivable,f.accounts.revenue), /source amount/);
rejects('incorrect debit account role rejected', (tx,f)=>entry(tx,f,'order',f.order,'100',f.accounts.payoneer,f.accounts.revenue), /posting rule/);
rejects('incorrect currency rejected', (tx,f)=>orderPosting(tx,f,{currency:'PKR'}), /foreign key|currency/i);
rejects('invalid source reference rejected', (tx,f)=>entry(tx,f,'order',uuid(),'100',f.accounts.receivable,f.accounts.revenue), /source must exist/);
rejects('duplicate source posting rejected despite different retry key', async(tx,f)=>{await orderPosting(tx,f); await orderPosting(tx,f);}, /unique|duplicate/i);
rejects('finalized entry cannot be edited', async(tx,f)=>{const id=await orderPosting(tx,f); await tx`UPDATE journal_entries SET description='changed' WHERE id=${id}`;}, /immutable/);
rejects('finalized entry cannot be deleted', async(tx,f)=>{const id=await orderPosting(tx,f); await tx`DELETE FROM journal_entries WHERE id=${id}`;}, /immutable/);
rejects('finalized line cannot be edited', async(tx,f)=>{const id=await orderPosting(tx,f); await tx`UPDATE journal_lines SET debit_amount=99 WHERE journal_entry_id=${id} AND debit_amount>0`;}, /immutable/);
rejects('draft cannot be directly reversed', async(tx,f)=>{const id=await orderPosting(tx,f,{draft:true}); await tx`UPDATE journal_entries SET status='REVERSED',finalized_at=now() WHERE id=${id}`;}, /legacy-only/);
integration('atomic reversal copies exact opposite lines and preserves original', async(tx,f)=>{
  const original=await orderPosting(tx,f),key=uuid();
  const [r]=await tx`SELECT reverse_journal_entry(${f.tenant},${original},${key},now()) AS id`;
  const [retry]=await tx`SELECT reverse_journal_entry(${f.tenant},${original},${key},now()) AS id`;
  assert.equal(r.id,retry.id);
  const [row]=await tx`SELECT status FROM journal_entries WHERE id=${original}`; assert.equal(row.status,'FINALIZED');
  const lines=await tx`SELECT debit_amount,credit_amount FROM journal_lines WHERE journal_entry_id=${r.id} ORDER BY debit_amount`;
  assert.deepEqual(lines.map(l=>[l.debit_amount,l.credit_amount]),[['0.0000','100.0000'],['100.0000','0.0000']]);
});
rejects('reversal entry cannot be edited', async(tx,f)=>{const id=await orderPosting(tx,f); const [r]=await tx`SELECT reverse_journal_entry(${f.tenant},${id},${uuid()},now()) AS id`; await tx`UPDATE journal_entries SET description='changed' WHERE id=${r.id}`;}, /immutable/);
rejects('reversal entry cannot be deleted', async(tx,f)=>{const id=await orderPosting(tx,f); const [r]=await tx`SELECT reverse_journal_entry(${f.tenant},${id},${uuid()},now()) AS id`; await tx`DELETE FROM journal_entries WHERE id=${r.id}`;}, /immutable/);
rejects('reversal must exactly offset original', async(tx,f)=>{const id=await orderPosting(tx,f);await entry(tx,f,'adjustment',id,'99',f.accounts.revenue,f.accounts.receivable,{event:'REVERSAL',reversal:id});}, /exactly offset/);
rejects('duplicate reversal with a new event key rejected', async(tx,f)=>{const id=await orderPosting(tx,f);await tx`SELECT reverse_journal_entry(${f.tenant},${id},${uuid()},now())`;await tx`SELECT reverse_journal_entry(${f.tenant},${id},${uuid()},now())`;}, /already has a reversal/);
rejects('reversal chain rejected', async(tx,f)=>{const id=await orderPosting(tx,f);const [r]=await tx`SELECT reverse_journal_entry(${f.tenant},${id},${uuid()},now()) AS id`;await tx`SELECT reverse_journal_entry(${f.tenant},${r.id},${uuid()},now())`;}, /original finalized/);
rejects('draft supplier purchase cannot post actual costs', (tx,f)=>entry(tx,f,'supplier_purchase',f.purchase,'40',f.accounts.supplierCost,f.accounts.payoneer), /confirmed purchase/);
integration('confirmed supplier purchase with matching items and journal', confirmPurchase);
rejects('confirmed supplier purchase requires matching item total', async(tx,f)=>{await tx`UPDATE supplier_purchase_items SET total_cost=39 WHERE id=${f.purchaseItem}`;await confirmPurchase(tx,f);}, /sum to the purchase total/);
rejects('confirmed purchase requires initial posting', async(tx,f)=>{await tx`UPDATE supplier_purchases SET status='CONFIRMED',purchase_date=now(),confirmed_at=now() WHERE id=${f.purchase}`;}, /commit atomically/);
rejects('confirmed purchase items cannot change', async(tx,f)=>{await confirmPurchase(tx,f);await tx`UPDATE supplier_purchase_items SET total_cost=39 WHERE id=${f.purchaseItem}`;}, /immutable/);
rejects('supplier refund requires confirmed purchase', async(tx,f)=>{const id=uuid();await tx`INSERT INTO supplier_refunds(id,account_id,supplier_purchase_id,refund_date,refund_amount,currency) VALUES(${id},${f.tenant},${f.purchase},now(),5,'USD')`;await entry(tx,f,'supplier_refund',id,'5',f.accounts.payoneer,f.accounts.supplierCost);}, /confirmed purchase/);
integration('partial supplier refund offsets actual cost', async(tx,f)=>{await confirmPurchase(tx,f);const id=uuid();await tx`INSERT INTO supplier_refunds(id,account_id,supplier_purchase_id,refund_date,refund_amount,currency) VALUES(${id},${f.tenant},${f.purchase},now(),5,'USD')`;await entry(tx,f,'supplier_refund',id,'5',f.accounts.payoneer,f.accounts.supplierCost);});
integration('partial customer refund posts the refund amount only', async(tx,f)=>{const id=uuid();await tx`INSERT INTO refunds(id,account_id,order_id,refund_date,refund_amount,currency,refund_type) VALUES(${id},${f.tenant},${f.order},now(),15,'USD','PARTIAL')`;await entry(tx,f,'refund',id,'15',f.accounts.refund,f.accounts.receivable);});
integration('confirmed shared expense posts once', async(tx,f)=>{const id=uuid();await tx`INSERT INTO expenses(id,account_id,category_id,expense_type,amount,currency,expense_date,status) VALUES(${id},${f.tenant},${f.category},'SHARED',3,'USD',now(),'CONFIRMED')`;await entry(tx,f,'expense',id,'3',f.accounts.shared,f.accounts.payoneer);});
rejects('expense source amount cannot be inflated', async(tx,f)=>{const id=uuid();await tx`INSERT INTO expenses(id,account_id,category_id,expense_type,amount,currency,expense_date,status) VALUES(${id},${f.tenant},${f.category},'SHARED',3,'USD',now(),'CONFIRMED')`;await entry(tx,f,'expense',id,'4',f.accounts.shared,f.accounts.payoneer);}, /source amount/);
integration('Etsy payout is separate from Payoneer deposit', async(tx,f)=>{const id=uuid();await tx`INSERT INTO etsy_payouts(id,account_id,payout_date,actual_amount,currency) VALUES(${id},${f.tenant},now(),25,'USD')`;await entry(tx,f,'etsy_payout',id,'25',f.accounts.payout,f.accounts.receivable);const p=await payoneer(tx,f,'DEPOSIT','25');await entry(tx,f,'payoneer_transaction',p,'25',f.accounts.payoneer,f.accounts.payout);});
integration('USD withdrawal principal is an asset transfer', async(tx,f)=>{const p=await payoneer(tx,f);await entry(tx,f,'payoneer_transaction',p,'10',f.accounts.usdClearing,f.accounts.payoneer);});
rejects('USD withdrawal principal cannot be an expense', async(tx,f)=>{const p=await payoneer(tx,f);await entry(tx,f,'payoneer_transaction',p,'10',f.accounts.shared,f.accounts.payoneer);}, /posting rule/);
integration('Payoneer fee is a separate shared expense event', async(tx,f)=>{const p=await payoneer(tx,f,'WITHDRAWAL','10','2');await entry(tx,f,'payoneer_transaction',p,'10',f.accounts.usdClearing,f.accounts.payoneer);await entry(tx,f,'payoneer_transaction',p,'2',f.accounts.shared,f.accounts.payoneer,{event:'FEE'});});
integration('bank entry uses actual PKR, independent of FX product', async(tx,f)=>{const w=await withdrawal(tx,f);await entry(tx,f,'bank_withdrawal',w.id,'2790',f.accounts.bank,f.accounts.pkrClearing,{currency:'PKR'});});
rejects('bank entry cannot post USD principal as PKR receipt', async(tx,f)=>{const w=await withdrawal(tx,f);await entry(tx,f,'bank_withdrawal',w.id,'10',f.accounts.bank,f.accounts.pkrClearing,{currency:'PKR'});}, /source amount/);
rejects('duplicate withdrawal posting rejected', async(tx,f)=>{const p=await payoneer(tx,f);await entry(tx,f,'payoneer_transaction',p,'10',f.accounts.usdClearing,f.accounts.payoneer);await entry(tx,f,'payoneer_transaction',p,'10',f.accounts.usdClearing,f.accounts.payoneer);}, /unique|duplicate/i);
rejects('ambiguous event without instructions rejected', async(tx,f)=>{const p=await payoneer(tx,f,'OTHER','5');await entry(tx,f,'payoneer_transaction',p,'5',f.accounts.shared,f.accounts.payoneer);}, /explicit posting instructions/);
integration('negative adjustment uses declared net movement instead of total debits', async(tx,f)=>{const p=await payoneer(tx,f,'ADJUSTMENT','-5');await declared(tx,f,'payoneer_transaction',p,'-5','5',f.accounts.shared,f.accounts.payoneer,{basis:'NET_DEBIT',control:f.accounts.payoneer});});
integration('opening balance uses declared control account and legs', async(tx,f)=>{await declared(tx,f,'opening_balance',f.accounts.payoneer,'100','100',f.accounts.payoneer,f.accounts.equity,{basis:'NET_DEBIT',control:f.accounts.payoneer});});
integration('generic adjustment has a stable declared correction event', async(tx,f)=>{const original=await orderPosting(tx,f);await declared(tx,f,'adjustment',original,'5','5',f.accounts.refund,f.accounts.receivable,{event:'correction-1'});});
rejects('finalized declaration cannot gain extra posting legs', async(tx,f)=>{const p=await payoneer(tx,f,'OTHER','5');const d=await declared(tx,f,'payoneer_transaction',p,'5','5',f.accounts.shared,f.accounts.payoneer);await tx`INSERT INTO financial_posting_legs(account_id,posting_event_id,financial_account_id,debit_amount,currency) VALUES(${f.tenant},${d.id},${f.accounts.shared},1,'USD')`;}, /immutable/);
rejects('analytical allocations cannot be ledger sources', (tx,f)=>entry(tx,f,'expense_allocation',uuid(),'5',f.accounts.shared,f.accounts.payoneer), /Unsupported financial source/);
rejects('product defaults cannot be ledger sources', (tx,f)=>entry(tx,f,'product',uuid(),'5',f.accounts.shared,f.accounts.payoneer), /Unsupported financial source/);
integration('multiple shipments per order retain initial events', async(tx,f)=>{await shipment(tx,f);await shipment(tx,f);const [row]=await tx`SELECT count(*)::int AS count FROM shipments WHERE order_id=${f.order}`;assert.equal(row.count,2);const [events]=await tx`SELECT count(*)::int AS count FROM shipment_events WHERE account_id=${f.tenant}`;assert.equal(events.count,2);});
rejects('cross-tenant shipment order reference fails', (tx,f)=>shipment(tx,f,f.tenant,f.otherOrder), /foreign key/i);
rejects('cross-tenant shipment event reference fails', async(tx,f)=>{const id=await shipment(tx,f);await shipEvent(tx,f,id,'NOTE',undefined,f.other);}, /same-tenant|foreign key/i);
integration('shipment events project status without changing order delivery', async(tx,f)=>{const id=await shipment(tx,f);await shipEvent(tx,f,id,'SHIPPED');await shipEvent(tx,f,id,'DELIVERED','2026-11-21T00:00:00Z');const [s]=await tx`SELECT shipment_status FROM shipments WHERE id=${id}`;assert.equal(s.shipment_status,'DELIVERED');const [o]=await tx`SELECT delivered_at,status FROM orders WHERE id=${f.order}`;assert.equal(o.delivered_at,null);assert.equal(o.status,'NEW');});
rejects('shipment event history cannot be deleted', async(tx,f)=>{const id=await shipment(tx,f);await tx`DELETE FROM shipment_events WHERE shipment_id=${id}`;}, /append-only/);
rejects('shipment event history cannot be edited', async(tx,f)=>{const id=await shipment(tx,f);await tx`UPDATE shipment_events SET description='changed' WHERE shipment_id=${id}`;}, /append-only/);
rejects('shipment cannot be deleted', async(tx,f)=>{const id=await shipment(tx,f);await tx`DELETE FROM shipments WHERE id=${id}`;}, /cannot be deleted/);
rejects('invalid shipment transition rejected', async(tx,f)=>{const id=await shipment(tx,f);await shipEvent(tx,f,id,'DELIVERED');}, /Invalid shipment status transition/);
rejects('shipment direct status mutation rejected', async(tx,f)=>{const id=await shipment(tx,f);await tx`UPDATE shipments SET shipment_status='SHIPPED',shipped_at=now() WHERE id=${id}`;}, /appending an event/);
rejects('cross-tenant journal source rejected', (tx,f)=>entry(tx,f,'order',f.otherOrder,'100',f.accounts.receivable,f.accounts.revenue), /source must exist/);
rejects('cross-tenant journal financial account rejected', async(tx,f)=>{const id=uuid();await tx`INSERT INTO financial_accounts(id,account_id,name,account_type,account_role,currency) VALUES(${id},${f.other},'Other receivable','ASSET','ETSY_RECEIVABLE','USD')`;await entry(tx,f,'order',f.order,'100',id,f.accounts.revenue);}, /foreign key/i);

integration('signed refund adjustment uses explicit legs and net basis', async(tx,f)=>{
  const refund=uuid(),adjustment=uuid();
  await tx`INSERT INTO refunds(id,account_id,order_id,refund_date,refund_amount,currency,refund_type) VALUES(${refund},${f.tenant},${f.order},now(),15,'USD','PARTIAL')`;
  await tx`INSERT INTO refund_adjustments(id,account_id,refund_id,adjustment_type,amount,currency) VALUES(${adjustment},${f.tenant},${refund},'MANUAL_CORRECTION',-2,'USD')`;
  await declared(tx,f,'refund_adjustment',adjustment,'-2','2',f.accounts.receivable,f.accounts.refund,{basis:'NET_DEBIT',control:f.accounts.refund});
});
rejects('journal must match the exact declared legs', async(tx,f)=>{
  const p=await payoneer(tx,f,'OTHER','5');
  await declared(tx,f,'payoneer_transaction',p,'5','5',f.accounts.shared,f.accounts.payoneer,{journalAmount:'4'});
}, /exactly match explicit/);
rejects('self-referencing reversal rejected', async(tx,f)=>{
  const id=uuid();
  await tx`INSERT INTO journal_entries(id,account_id,source_type,source_id,source_event,currency,transaction_date,idempotency_key,reversal_of_entry_id) VALUES(${id},${f.tenant},'adjustment',${id},'REVERSAL','USD',now(),${uuid()},${id})`;
}, /journal_reversal_shape/);
rejects('cross-tenant reversal original rejected', async(tx,f)=>{
  const receivable=uuid(),revenue=uuid();
  await tx`INSERT INTO financial_accounts(id,account_id,name,account_type,account_role,currency) VALUES(${receivable},${f.other},'Other receivable','ASSET','ETSY_RECEIVABLE','USD'),(${revenue},${f.other},'Other revenue','INCOME','REVENUE','USD')`;
  const original=await entry(tx,{...f,tenant:f.other},'order',f.otherOrder,'100',receivable,revenue);
  await entry(tx,f,'adjustment',original,'100',f.accounts.revenue,f.accounts.receivable,{event:'REVERSAL',reversal:original});
}, /foreign key/);
rejects('finalized declared event cannot change its amount', async(tx,f)=>{
  const p=await payoneer(tx,f,'OTHER','5'),d=await declared(tx,f,'payoneer_transaction',p,'5','5',f.accounts.shared,f.accounts.payoneer);
  await tx`UPDATE financial_posting_events SET source_amount=6 WHERE id=${d.id}`;
}, /immutable/);
integration('terminal shipment keeps historical notes and metadata audit', async(tx,f)=>{
  const id=await shipment(tx,f);await shipEvent(tx,f,id,'CANCELLED');
  await shipEvent(tx,f,id,'NOTE','2026-11-19T00:00:00Z');
  await tx`UPDATE shipments SET tracking_number='manual-reference' WHERE id=${id}`;
  const [s]=await tx`SELECT shipment_status FROM shipments WHERE id=${id}`;assert.equal(s.shipment_status,'CANCELLED');
  const [a]=await tx`SELECT count(*)::int AS count FROM audit_logs WHERE entity_id=${id}`;assert.equal(a.count,1);
});

rejects('duplicate expense posting rejected', async(tx,f)=>{
  const id=uuid();await tx`INSERT INTO expenses(id,account_id,category_id,expense_type,amount,currency,expense_date,status) VALUES(${id},${f.tenant},${f.category},'SHARED',3,'USD',now(),'CONFIRMED')`;
  await entry(tx,f,'expense',id,'3',f.accounts.shared,f.accounts.payoneer);
  await entry(tx,f,'expense',id,'3',f.accounts.shared,f.accounts.payoneer);
}, /unique|duplicate/i);
rejects('duplicate embedded fee posting rejected', async(tx,f)=>{
  const id=await payoneer(tx,f,'WITHDRAWAL','10','2');
  await entry(tx,f,'payoneer_transaction',id,'2',f.accounts.shared,f.accounts.payoneer,{event:'FEE'});
  await entry(tx,f,'payoneer_transaction',id,'2',f.accounts.shared,f.accounts.payoneer,{event:'FEE'});
}, /unique|duplicate/i);
rejects('duplicate actual PKR receipt posting rejected', async(tx,f)=>{
  const w=await withdrawal(tx,f);
  await entry(tx,f,'bank_withdrawal',w.id,'2790',f.accounts.bank,f.accounts.pkrClearing,{currency:'PKR'});
  await entry(tx,f,'bank_withdrawal',w.id,'2790',f.accounts.bank,f.accounts.pkrClearing,{currency:'PKR'});
}, /unique|duplicate/i);


// Follow-up regressions: status chronology, effective reversal state and audit notes.
for (const status of ['SHIPPED', 'CANCELLED']) {
  rejects(`${status} event before shipment creation rejected`, async(tx,f)=>{
    const id=await shipment(tx,f,f.tenant,f.order,'2026-11-20T00:00:00Z');
    await shipEvent(tx,f,id,status,'2026-11-19T23:59:59.999Z');
  }, /status event cannot precede shipment creation/);
}
integration('shipment status event exactly at creation remains valid', async(tx,f)=>{
  const id=await shipment(tx,f,f.tenant,f.order,'2026-11-20T00:00:00Z');
  await shipEvent(tx,f,id,'SHIPPED','2026-11-20T00:00:00Z');
  const [s]=await tx`SELECT shipment_status,shipped_at,created_at FROM shipments WHERE id=${id}`;
  assert.equal(s.shipment_status,'SHIPPED');assert.equal(s.shipped_at.getTime(),s.created_at.getTime());
});
integration('historical NOTE before shipment creation is preserved without changing state', async(tx,f)=>{
  const id=await shipment(tx,f,f.tenant,f.order,'2026-11-20T00:00:00Z');
  await shipEvent(tx,f,id,'NOTE','2026-11-18T00:00:00Z');
  const [event]=await tx`SELECT event_date FROM shipment_events WHERE shipment_id=${id} AND event_type='NOTE'`;
  assert.equal(event.event_date.toISOString(),'2026-11-18T00:00:00.000Z');
  const [s]=await tx`SELECT shipment_status,shipped_at,delivered_at FROM shipments WHERE id=${id}`;
  assert.equal(s.shipment_status,'PENDING');assert.equal(s.shipped_at,null);assert.equal(s.delivered_at,null);
});
rejects('generic adjustment against a finalized reversed original rejected', async(tx,f)=>{
  const original=await orderPosting(tx,f);
  await tx`SELECT reverse_journal_entry(${f.tenant},${original},${uuid()},now())`;
  // Force a validated reversal first; the original still retains FINALIZED status.
  await tx.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
  await declared(tx,f,'adjustment',original,'5','5',f.accounts.refund,f.accounts.receivable,{event:'correction-after-reversal'});
}, /Cannot adjust an original journal with a finalized reversal/);
rejects('same-transaction reversal blocks an earlier queued generic adjustment', async(tx,f)=>{
  const original=await orderPosting(tx,f);
  await declared(tx,f,'adjustment',original,'5','5',f.accounts.refund,f.accounts.receivable,{event:'correction-before-reversal'});
  await tx`SELECT reverse_journal_entry(${f.tenant},${original},${uuid()},now())`;
}, /Cannot adjust an original journal with a finalized reversal/);
integration('draft reversal does not make an original effectively reversed', async(tx,f)=>{
  const original=await orderPosting(tx,f);
  await entry(tx,f,'adjustment',original,'100',f.accounts.revenue,f.accounts.receivable,{event:'REVERSAL',reversal:original,draft:true});
  await declared(tx,f,'adjustment',original,'5','5',f.accounts.refund,f.accounts.receivable,{event:'correction-with-draft-reversal'});
});
integration('notes-only shipment edits audit old/new notes including null transitions', async(tx,f)=>{
  const id=await shipment(tx,f);
  await tx`UPDATE shipments SET notes='First note' WHERE id=${id}`;
  await tx`UPDATE shipments SET notes='Updated note' WHERE id=${id}`;
  await tx`UPDATE shipments SET notes=NULL WHERE id=${id}`;
  const rows=await tx`SELECT before_data,after_data FROM audit_logs WHERE entity_type='shipment' AND entity_id=${id} AND action='METADATA_UPDATED'`;
  assert.equal(rows.length,3);
  for (const row of rows) {assert(Object.hasOwn(row.before_data,'notes'));assert(Object.hasOwn(row.after_data,'notes'));}
  const changes=rows.map(r=>JSON.stringify([r.before_data.notes,r.after_data.notes])).sort();
  assert.deepEqual(changes,[[null,'First note'],['First note','Updated note'],['Updated note',null]].map(v=>JSON.stringify(v)).sort());
  const [history]=await tx`SELECT count(*)::int AS count FROM shipment_events WHERE shipment_id=${id} AND event_type='NOTE'`;
  assert.equal(history.count,3);
});
integration('other shipment metadata edits also snapshot unchanged notes', async(tx,f)=>{
  const id=await shipment(tx,f);
  await tx`UPDATE shipments SET notes='Keep this note' WHERE id=${id}`;
  await tx`UPDATE shipments SET carrier='Manual carrier' WHERE id=${id}`;
  const rows=await tx`SELECT before_data,after_data FROM audit_logs WHERE entity_id=${id} AND after_data->>'carrier'='Manual carrier'`;
  assert.equal(rows.length,1);assert.equal(rows[0].before_data.notes,'Keep this note');assert.equal(rows[0].after_data.notes,'Keep this note');
});

integration('negative OTHER transaction without reconciliation has no deposit-cap violation', async(tx,f)=>{
  const p=await payoneer(tx,f,'OTHER','-7');
  await declared(tx,f,'payoneer_transaction',p,'-7','7',f.accounts.shared,f.accounts.payoneer,{basis:'NET_DEBIT',control:f.accounts.payoneer});
});
