const { randomUUID: uuid } = require('node:crypto');

async function fixture(tx) {
  const f = { tenant: uuid(), other: uuid(), order: uuid(), otherOrder: uuid(), orderItem: uuid(), supplier: uuid(), purchase: uuid(), purchaseItem: uuid(), category: uuid(), accounts: {} };
  for (const account of [f.tenant, f.other]) {
    const user = uuid();
    await tx`INSERT INTO "user"(id,name,email) VALUES(${user},'Test owner',${user + '@example.test'})`;
    await tx`INSERT INTO business_accounts(id,owner_user_id,shop_name) VALUES(${account},${user},'Test shop')`;
  }
  for (const [account, order] of [[f.tenant, f.order], [f.other, f.otherOrder]]) {
    await tx`INSERT INTO orders(id,account_id,etsy_order_id,order_date,net_payable_amount,currency) VALUES(${order},${account},${order},now(),100,'USD')`;
  }
  const definitions = [
    ['receivable','ASSET','ETSY_RECEIVABLE','USD'], ['revenue','INCOME','REVENUE','USD'],
    ['payout','ASSET','ETSY_PAYOUT_CLEARING','USD'], ['payoneer','ASSET','PAYONEER','USD'],
    ['usdClearing','ASSET','TRANSFER_CLEARING','USD'], ['bank','ASSET','BANK','PKR'],
    ['pkrClearing','ASSET','TRANSFER_CLEARING','PKR'], ['supplierCost','EXPENSE','SUPPLIER_COST','USD'],
    ['direct','EXPENSE','DIRECT_EXPENSE','USD'], ['shared','EXPENSE','SHARED_EXPENSE','USD'],
    ['refund','INCOME','REFUND','USD'], ['equity','EQUITY','UNCLASSIFIED','USD'],
  ];
  for (const [name,type,role,currency] of definitions) {
    const id = uuid(); f.accounts[name] = id;
    await tx`INSERT INTO financial_accounts(id,account_id,name,account_type,account_role,currency) VALUES(${id},${f.tenant},${name},${type},${role},${currency})`;
  }
  await tx`INSERT INTO order_items(id,account_id,order_id,product_name_snapshot,quantity) VALUES(${f.orderItem},${f.tenant},${f.order},'Test item',1)`;
  await tx`INSERT INTO suppliers(id,account_id,name,marketplace) VALUES(${f.supplier},${f.tenant},'Test supplier','CUSTOM')`;
  await tx`INSERT INTO supplier_purchases(id,account_id,supplier_id,total_amount,currency) VALUES(${f.purchase},${f.tenant},${f.supplier},40,'USD')`;
  await tx`INSERT INTO supplier_purchase_items(id,account_id,supplier_purchase_id,order_item_id,quantity,unit_cost,total_cost,currency) VALUES(${f.purchaseItem},${f.tenant},${f.purchase},${f.orderItem},1,40,40,'USD')`;
  await tx`INSERT INTO expense_categories(id,account_id,name,category_type) VALUES(${f.category},${f.tenant},'Test shared','CUSTOM')`;
  return f;
}
async function entry(tx,f,type,source,amount,debit,credit,options={}) {
  const id=uuid(), currency=options.currency || 'USD';
  await tx`INSERT INTO journal_entries(id,account_id,source_type,source_id,source_event,currency,transaction_date,idempotency_key,reversal_of_entry_id,posting_event_id)
    VALUES(${id},${f.tenant},${type},${source},${options.event || 'INITIAL'},${currency},now(),${options.key || uuid()},${options.reversal || null},${options.declaration || null})`;
  await tx`INSERT INTO journal_lines(account_id,journal_entry_id,financial_account_id,debit_amount,credit_amount,currency)
    VALUES(${f.tenant},${id},${debit},${amount},0,${currency}),(${f.tenant},${id},${credit},0,${options.creditAmount || amount},${currency})`;
  if (!options.draft) await tx`UPDATE journal_entries SET status='FINALIZED',finalized_at=now() WHERE id=${id}`;
  return id;
}
const orderPosting = (tx,f,options={}) => entry(tx,f,'order',f.order,'100',f.accounts.receivable,f.accounts.revenue,options);
async function confirmPurchase(tx,f) {
  await tx`UPDATE supplier_purchases SET status='CONFIRMED',purchase_date=now(),confirmed_at=now() WHERE id=${f.purchase}`;
  return entry(tx,f,'supplier_purchase',f.purchase,'40',f.accounts.supplierCost,f.accounts.payoneer);
}
async function payoneer(tx,f,type='WITHDRAWAL',amount='10',fee=null) {
  const id=uuid();
  await tx`INSERT INTO payoneer_transactions(id,account_id,transaction_date,transaction_type,amount,currency,fee_amount,fee_currency)
    VALUES(${id},${f.tenant},now(),${type},${amount},'USD',${fee},${fee === null ? null : 'USD'})`;
  return id;
}
async function withdrawal(tx,f) {
  const transaction=await payoneer(tx,f), id=uuid();
  await tx`INSERT INTO bank_withdrawals(id,account_id,payoneer_transaction_id,withdrawal_date,usd_amount,actual_pkr_received,actual_exchange_rate)
    VALUES(${id},${f.tenant},${transaction},now(),10,2790,280)`;
  return {id,transaction}; // No false equality: actual net receipt is not usd * rate.
}
async function declared(tx,f,type,source,sourceAmount,amount,debit,credit,options={}) {
  const id=uuid(),key=uuid(),event=options.event || 'INITIAL';
  await tx`INSERT INTO financial_posting_events(id,account_id,event_key,source_type,source_id,source_event,source_amount,currency,amount_basis,control_financial_account_id)
    VALUES(${id},${f.tenant},${key},${type},${source},${event},${sourceAmount},'USD',${options.basis || 'TOTAL_DEBITS'},${options.control || null})`;
  await tx`INSERT INTO financial_posting_legs(account_id,posting_event_id,financial_account_id,debit_amount,credit_amount,currency)
    VALUES(${f.tenant},${id},${debit},${amount},0,'USD'),(${f.tenant},${id},${credit},0,${amount},'USD')`;
  const journal=await entry(tx,f,type,source,options.journalAmount || amount,debit,credit,{event,key,declaration:id});
  return {id,journal,key};
}
async function shipment(tx,f,account=f.tenant,order=f.order,createdAt='2026-11-19T00:00:00Z') {
  const id=uuid(); await tx`INSERT INTO shipments(id,account_id,order_id,created_at) VALUES(${id},${account},${order},${createdAt})`; return id;
}
async function shipEvent(tx,f,id,type,date='2026-11-20T00:00:00Z',account=f.tenant) {
  await tx`INSERT INTO shipment_events(account_id,shipment_id,event_type,event_date) VALUES(${account},${id},${type},${date})`;
}

module.exports = { fixture, entry, orderPosting, confirmPurchase, payoneer, withdrawal, declared, shipment, shipEvent };
