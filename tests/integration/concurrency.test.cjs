const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID: uuid } = require('node:crypto');
const postgres = require('postgres');
const { validateLocalTestDatabase } = require('../helpers/local-database.cjs');
const { fixture, orderPosting, confirmPurchase, payoneer, shipment, shipEvent } = require('../helpers/financial-fixture.cjs');
const url = process.env.LOCAL_TEST_DATABASE_URL;
const clients = url ? [0, 1, 2].map(() => postgres(validateLocalTestDatabase(url), { max: 1, onnotice() {}, connect_timeout: 3 })) : [];
const [observer, a, b] = clients;
after(async () => { await Promise.all(clients.map(c => c.end({ timeout: 2 }))); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function integration(name, fn) {
  test(name, { skip: !url && 'Dedicated local PostgreSQL required', timeout: 20000 }, async () => {
    const [ap] = await a`SELECT pg_backend_pid() AS pid`, [bp] = await b`SELECT pg_backend_pid() AS pid`;
    assert.notEqual(ap.pid, bp.pid, 'Workers must use independent PostgreSQL sessions');
    const f = await observer.begin(tx => fixture(tx));
    await fn(f, { a: ap.pid, b: bp.pid });
  });
}
async function waitForLock(pid) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const [row] = await observer`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`;
    if (row?.wait_event_type === 'Lock') return;
    await pause(15);
  }
  throw new Error('Second independent worker never reached a real PostgreSQL lock wait');
}
async function retryTransaction(client, operation, errors, beginOptions='') {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await client.begin(beginOptions, tx => operation(tx, attempt)); }
    catch (error) {
      if (!['40001','40P01'].includes(error.code) || attempt === 3) throw error;
      errors.push(error.code);
      await pause(20 * attempt);
    }
  }
}
async function overlapping(operationA, operationB, pidB, options={}) {
  const ready = deferred(), release = deferred();
  const first = a.begin(async tx => { await operationA(tx); ready.resolve(); await release.promise; });
  // Attach rejection handlers immediately, including while the other worker waits.
  const firstResult = first.then(value => ({status:'fulfilled',value}), reason => ({status:'rejected',reason}));
  await Promise.race([ready.promise, firstResult.then(r => { if(r.status==='rejected') throw r.reason; })]);
  const second = options.retryErrors
    ? retryTransaction(b,operationB,options.retryErrors,options.isolation || '')
    : b.begin(options.isolation || '',operationB);
  const secondResult = second.then(value => ({status:'fulfilled',value}), reason => ({status:'rejected',reason}));
  try { await waitForLock(pidB); } finally { release.resolve(); }
  const results = await Promise.all([firstResult,secondResult]);
  assert.equal(results[0].status,'fulfilled',results[0].reason?.message);
  return results;
}
const expectSecondFailure = (results,pattern) => {
  assert.equal(results[1].status,'rejected'); assert.match(results[1].reason.message,pattern);
};
async function countEntries(f,type,source) {
  const [row]=await observer`SELECT count(*)::int AS count FROM journal_entries WHERE account_id=${f.tenant} AND source_type=${type} AND source_id=${source}`;
  return row.count;
}
async function payout(tx,f,amount='100') {
  const id=uuid();await tx`INSERT INTO etsy_payouts(id,account_id,payout_date,actual_amount,currency) VALUES(${id},${f.tenant},now(),${amount},'USD')`;return id;
}
async function expectedItems(f) {
  return observer.begin(async tx=>{
    const batch=uuid(),otherOrder=uuid(),items=[uuid(),uuid()];
    await tx`INSERT INTO orders(id,account_id,etsy_order_id,order_date,net_payable_amount,currency) VALUES(${otherOrder},${f.tenant},${otherOrder},now(),100,'USD')`;
    await tx`INSERT INTO payout_batches(id,account_id,expected_payout_date,expected_total_amount,currency) VALUES(${batch},${f.tenant},'2026-11-30',200,'USD')`;
    await tx`INSERT INTO payout_batch_items(id,account_id,payout_batch_id,order_id,expected_amount,currency) VALUES(${items[0]},${f.tenant},${batch},${f.order},100,'USD'),(${items[1]},${f.tenant},${batch},${otherOrder},100,'USD')`;
    return items;
  });
}
async function allocate(tx,f,payoutId,itemId) {
  await tx`INSERT INTO etsy_payout_allocations(account_id,etsy_payout_id,payout_batch_item_id,allocated_amount,currency) VALUES(${f.tenant},${payoutId},${itemId},60,'USD')`;
}
async function reconcile(tx,f,deposit,payoutId) {
  await tx`INSERT INTO payoneer_reconciliations(account_id,payoneer_transaction_id,etsy_payout_id,allocated_amount,currency,status,confirmed_at) VALUES(${f.tenant},${deposit},${payoutId},60,'USD','CONFIRMED',now())`;
}

integration('two supplier confirmations commit exactly one immutable cost posting', async(f,pids)=>{
  const results=await overlapping(tx=>confirmPurchase(tx,f),tx=>confirmPurchase(tx,f),pids.b);
  expectSecondFailure(results,/immutable|adjustment|duplicate/i);
  assert.equal(await countEntries(f,'supplier_purchase',f.purchase),1);
  const [purchase]=await observer`SELECT status FROM supplier_purchases WHERE id=${f.purchase}`;assert.equal(purchase.status,'CONFIRMED');
});
integration('two source postings cannot commit duplicate financial events', async(f,pids)=>{
  const results=await overlapping(tx=>orderPosting(tx,f),tx=>orderPosting(tx,f),pids.b);
  expectSecondFailure(results,/unique|duplicate/i);assert.equal(results[1].reason.code,'23505');
  assert.equal(await countEntries(f,'order',f.order),1);
});
integration('two same-key reversal requests return one committed reversal', async(f,pids)=>{
  const original=await observer.begin(tx=>orderPosting(tx,f)),key=uuid();
  let firstId;
  const results=await overlapping(async tx=>{const [r]=await tx`SELECT reverse_journal_entry(${f.tenant},${original},${key},now()) AS id`;firstId=r.id;},async tx=>{const [r]=await tx`SELECT reverse_journal_entry(${f.tenant},${original},${key},now()) AS id`;return r.id;},pids.b);
  assert.equal(results[1].status,'fulfilled',results[1].reason?.message);assert.equal(results[1].value,firstId);
  const [row]=await observer`SELECT count(*)::int AS count FROM journal_entries WHERE reversal_of_entry_id=${original}`;assert.equal(row.count,1);
});
integration('two different-key reversals cannot reverse an original twice', async(f,pids)=>{
  const original=await observer.begin(tx=>orderPosting(tx,f));
  const results=await overlapping(tx=>tx`SELECT reverse_journal_entry(${f.tenant},${original},${uuid()},now())`,tx=>tx`SELECT reverse_journal_entry(${f.tenant},${original},${uuid()},now())`,pids.b);
  expectSecondFailure(results,/already has a reversal/);
  const [row]=await observer`SELECT count(*)::int AS count FROM journal_entries WHERE reversal_of_entry_id=${original}`;assert.equal(row.count,1);
});
integration('concurrent Etsy allocations cannot exceed actual payout', async(f,pids)=>{
  const items=await expectedItems(f),p=await observer.begin(tx=>payout(tx,f));
  const results=await overlapping(tx=>allocate(tx,f,p,items[0]),tx=>allocate(tx,f,p,items[1]),pids.b);
  expectSecondFailure(results,/exceed actual payout/);
  const [row]=await observer`SELECT sum(allocated_amount)::text AS total,count(*)::int AS count FROM etsy_payout_allocations WHERE account_id=${f.tenant}`;
  assert.equal(row.total,'60.0000');assert.equal(row.count,1);
});
integration('concurrent Etsy allocations cannot exceed expected item', async(f,pids)=>{
  const [item]=await expectedItems(f),p1=await observer.begin(tx=>payout(tx,f)),p2=await observer.begin(tx=>payout(tx,f));
  const results=await overlapping(tx=>allocate(tx,f,p1,item),tx=>allocate(tx,f,p2,item),pids.b);
  expectSecondFailure(results,/exceeds expected item/);
  const [row]=await observer`SELECT sum(allocated_amount)::text AS total FROM etsy_payout_allocations WHERE account_id=${f.tenant}`;assert.equal(row.total,'60.0000');
});
integration('concurrent reconciliations cannot exceed deposit capacity', async(f,pids)=>{
  const d=await observer.begin(tx=>payoneer(tx,f,'DEPOSIT','100'));
  const p1=await observer.begin(tx=>payout(tx,f)),p2=await observer.begin(tx=>payout(tx,f));
  const results=await overlapping(tx=>reconcile(tx,f,d,p1),tx=>reconcile(tx,f,d,p2),pids.b);
  expectSecondFailure(results,/exceeds deposit or payout/);
  const [row]=await observer`SELECT sum(allocated_amount)::text AS total,count(*)::int AS count FROM payoneer_reconciliations WHERE account_id=${f.tenant}`;assert.equal(row.total,'60.0000');assert.equal(row.count,1);
});
integration('concurrent reconciliations cannot exceed payout capacity', async(f,pids)=>{
  const d1=await observer.begin(tx=>payoneer(tx,f,'DEPOSIT','100')),d2=await observer.begin(tx=>payoneer(tx,f,'DEPOSIT','100'));
  const p=await observer.begin(tx=>payout(tx,f));
  const results=await overlapping(tx=>reconcile(tx,f,d1,p),tx=>reconcile(tx,f,d2,p),pids.b);
  expectSecondFailure(results,/exceeds deposit or payout/);
  const [row]=await observer`SELECT sum(allocated_amount)::text AS total FROM payoneer_reconciliations WHERE account_id=${f.tenant}`;assert.equal(row.total,'60.0000');
});
integration('concurrent shipment events preserve a valid committed history', async(f,pids)=>{
  const id=await observer.begin(tx=>shipment(tx,f));
  const results=await overlapping(tx=>shipEvent(tx,f,id,'SHIPPED'),tx=>shipEvent(tx,f,id,'DELIVERED','2026-11-21T00:00:00Z'),pids.b);
  assert.equal(results[1].status,'fulfilled',results[1].reason?.message);
  const events=await observer`SELECT event_type FROM shipment_events WHERE shipment_id=${id} ORDER BY event_sequence`;
  assert.deepEqual(events.map(e=>e.event_type),['PENDING','SHIPPED','DELIVERED']);
  const [row]=await observer`SELECT shipment_status FROM shipments WHERE id=${id}`;assert.equal(row.shipment_status,'DELIVERED');
  const [order]=await observer`SELECT delivered_at FROM orders WHERE id=${f.order}`;assert.equal(order.delivered_at,null);
});
integration('deferred failure rolls back confirmation and every journal row', async(f)=>{
  let bodyCompleted=false;
  await assert.rejects(a.begin(async tx=>{
    await tx`UPDATE supplier_purchases SET status='CONFIRMED',confirmed_at=now(),purchase_date=now() WHERE id=${f.purchase}`;
    await require('../helpers/financial-fixture.cjs').entry(tx,f,'supplier_purchase',f.purchase,'39',f.accounts.supplierCost,f.accounts.payoneer);
    bodyCompleted=true; // No SET CONSTRAINTS: failure must occur at COMMIT.
  }),/source amount/);
  assert(bodyCompleted,'Failure must come from the deferred commit check');
  const [purchase]=await observer`SELECT status,confirmed_at FROM supplier_purchases WHERE id=${f.purchase}`;assert.equal(purchase.status,'DRAFT');assert.equal(purchase.confirmed_at,null);
  assert.equal(await countEntries(f,'supplier_purchase',f.purchase),0);
  const [lines]=await observer`SELECT count(*)::int AS count FROM journal_lines WHERE account_id=${f.tenant}`;assert.equal(lines.count,0);
});
integration('repeatable-read serialization failure retries the complete transaction safely', async(f,pids)=>{
  const other=uuid();
  await observer`INSERT INTO orders(id,account_id,etsy_order_id,order_date,net_payable_amount,currency) VALUES(${other},${f.tenant},${other},now(),100,'USD')`;
  const errors=[];
  const results=await overlapping(tx=>orderPosting(tx,f),async tx=>{
    await tx`SELECT id FROM business_accounts WHERE id=${f.tenant}`; // Establish repeatable-read snapshot before A commits.
    return orderPosting(tx,{...f,order:other});
  },pids.b,{retryErrors:errors,isolation:'isolation level repeatable read'});
  assert.equal(results[1].status,'fulfilled',results[1].reason?.message);assert.deepEqual(errors,['40001']);
  assert.equal(await countEntries(f,'order',f.order),1);assert.equal(await countEntries(f,'order',other),1);
});
integration('real two-connection deadlock retries the victim transaction', async(f)=>{
  const bothReady=deferred();let waiting=0;const errorsA=[],errorsB=[];
  async function operation(tx,attempt,first,second,label) {
    await tx`UPDATE orders SET notes=${label} WHERE id=${first}`;
    if(attempt===1){waiting++;if(waiting===2)bothReady.resolve();await bothReady.promise;}
    await tx`UPDATE orders SET notes=${label} WHERE id=${second}`;
  }
  const results=await Promise.allSettled([
    retryTransaction(a,(tx,attempt)=>operation(tx,attempt,f.order,f.otherOrder,'worker-a'),errorsA),
    retryTransaction(b,(tx,attempt)=>operation(tx,attempt,f.otherOrder,f.order,'worker-b'),errorsB),
  ]);
  assert(results.every(r=>r.status==='fulfilled'),results.find(r=>r.status==='rejected')?.reason?.message);
  assert.deepEqual([...errorsA,...errorsB],['40P01']);
  const rows=await observer`SELECT notes FROM orders WHERE id IN (${f.order},${f.otherOrder})`;
  assert.equal(rows.length,2);assert(rows.every(r=>r.notes===rows[0].notes),'Both writes of the successful retried transaction must commit');
});
