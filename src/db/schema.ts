import {
  pgTable, pgEnum, uuid, text, varchar, boolean, integer, bigint, numeric,
  timestamp, date, jsonb, index, unique, uniqueIndex, check, foreignKey
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/*
 * Etsy Payment Tracker - PostgreSQL schema v1.2
 * Better Auth owns the baseline authentication tables below; verify them
 * against the selected, pinned auth version before enabling authentication.
 */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => numeric(name, { precision: 19, scale: 4 }).notNull();
const nullableMoney = (name: string) => numeric(name, { precision: 19, scale: 4 });
const currency = (name = 'currency') => varchar(name, { length: 3 }).notNull();
const tenantId = () => uuid('account_id').notNull().references(() => businessAccounts.id, { onDelete: 'restrict' });

export const financialAccountRoleEnum = pgEnum('financial_account_role', ['UNCLASSIFIED', 'ETSY_RECEIVABLE', 'ETSY_PAYOUT_CLEARING', 'PAYONEER', 'BANK', 'TRANSFER_CLEARING', 'SUPPLIER_COST', 'DIRECT_EXPENSE', 'SHARED_EXPENSE', 'REVENUE', 'REFUND']);
export const postingAmountBasisEnum = pgEnum('posting_amount_basis', ['TOTAL_DEBITS', 'NET_DEBIT', 'NET_CREDIT']);
export const shipmentStatusEnum = pgEnum('shipment_status', ['PENDING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'EXCEPTION', 'RETURNED', 'CANCELLED']);
export const shipmentEventTypeEnum = pgEnum('shipment_event_type', ['PENDING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'EXCEPTION', 'RETURNED', 'CANCELLED', 'NOTE']);

export const orderStatusEnum = pgEnum('order_status', [
  'NEW', 'SUPPLIER_ORDERED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED',
  'PAYOUT_ELIGIBLE', 'PAYOUT_SCHEDULED', 'PARTIALLY_PAID', 'PAID',
  'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'
]);
export const supplierPurchaseStatusEnum = pgEnum('supplier_purchase_status', [
  'DRAFT', 'CONFIRMED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED'
]);
export const payoutEligibilityStatusEnum = pgEnum('payout_eligibility_status', ['PENDING', 'ELIGIBLE', 'ON_HOLD', 'CANCELLED']);
export const payoutBatchStatusEnum = pgEnum('payout_batch_status', ['EXPECTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'ADJUSTED']);
export const payoutStatusEnum = pgEnum('etsy_payout_status', ['RECORDED', 'PARTIALLY_ALLOCATED', 'ALLOCATED', 'ADJUSTED', 'REVERSED']);
export const transactionTypeEnum = pgEnum('payoneer_transaction_type', ['DEPOSIT', 'WITHDRAWAL', 'FEE', 'ADJUSTMENT', 'OTHER']);
export const reconciliationStatusEnum = pgEnum('reconciliation_status', ['SUGGESTED', 'CONFIRMED', 'REVERSED']);
export const expenseTypeEnum = pgEnum('expense_type', ['DIRECT', 'SHARED']);
export const recordStatusEnum = pgEnum('record_status', ['DRAFT', 'CONFIRMED', 'VOIDED']);
export const refundTypeEnum = pgEnum('refund_type', ['FULL', 'PARTIAL', 'OTHER']);
export const allocationMethodEnum = pgEnum('allocation_method', ['PROPORTIONAL', 'EQUAL', 'MANUAL', 'CUSTOM']);
export const financialAccountTypeEnum = pgEnum('financial_account_type', ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']);
export const journalStatusEnum = pgEnum('journal_status', ['DRAFT', 'FINALIZED', 'REVERSED']);
export const backgroundJobStatusEnum = pgEnum('background_job_status', ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
export const importStatusEnum = pgEnum('import_status', ['PENDING', 'PROCESSING', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED']);
export const importRowStatusEnum = pgEnum('import_row_status', ['PENDING', 'VALID', 'IMPORTED', 'DUPLICATE', 'FAILED']);

// Better Auth user identity. Configure Better Auth to use UUID IDs if desired;
// this v1 schema uses text IDs to match Better Auth's default ID strategy.
export const users = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('user_email_uq').on(t.email)]);

export const sessions = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => [uniqueIndex('session_token_uq').on(t.token), index('session_user_idx').on(t.userId)]);

export const authAccounts = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('auth_account_provider_uq').on(t.providerId, t.accountId), index('auth_account_user_idx').on(t.userId)]);

export const verifications = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('verification_identifier_idx').on(t.identifier)]);

// Better Auth database-backed rate limiting (migration 0009). Auth-owned and
// not tenant-scoped, like the four tables above. Shape matches Better Auth
// 1.7.25's generated Drizzle model: `last_request` is epoch milliseconds and
// the unique `key` ("<ip>|<path>") backs its atomic conditional increments.
export const rateLimits = pgTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
}, (t) => [uniqueIndex('rate_limit_key_uq').on(t.key)]);

// Tenant root. `business_accounts` avoids collision with Better Auth's `account`.
export const businessAccounts = pgTable('business_accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  shopName: varchar('shop_name', { length: 160 }).notNull(),
  baseCurrency: currency('base_currency').default('USD').notNull(),
  timezone: varchar('timezone', { length: 80 }).default('Asia/Karachi').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('business_accounts_owner_uq').on(t.ownerUserId), unique('business_accounts_owner_pair_uq').on(t.id, t.ownerUserId), check('business_base_currency_valid', sql`${t.baseCurrency} ~ '^[A-Z]{3}$'`)]);

export const accountSettings = pgTable('account_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  settingKey: varchar('setting_key', { length: 100 }).notNull(),
  settingValue: jsonb('setting_value').notNull(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('account_settings_key_uq').on(t.accountId, t.settingKey)]);

export const suppliers = pgTable('suppliers', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  name: varchar('name', { length: 180 }).notNull(),
  marketplace: varchar('marketplace', { length: 40 }).notNull(),
  websiteUrl: text('website_url'),
  notes: text('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [unique('suppliers_tenant_id_uq').on(t.accountId, t.id), index('suppliers_tenant_name_idx').on(t.accountId, t.name)]);

export const products = pgTable('products', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  name: varchar('name', { length: 240 }).notNull(),
  sku: varchar('sku', { length: 100 }),
  imageUrl: text('image_url'),
  defaultSupplierId: uuid('default_supplier_id'),
  defaultUnitCost: nullableMoney('default_unit_cost'),
  currency: currency(),
  notes: text('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('products_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('products_amounts_valid', sql`(${t.defaultUnitCost} IS NULL OR (${t.defaultUnitCost} >= 0 AND ${t.defaultUnitCost} < 'Infinity'::numeric))`),
  unique('products_tenant_id_uq').on(t.accountId, t.id),
  uniqueIndex('products_tenant_sku_uq').on(t.accountId, t.sku),
  foreignKey({ columns: [t.accountId, t.defaultSupplierId], foreignColumns: [suppliers.accountId, suppliers.id], name: 'products_supplier_tenant_fk' }),
  index('products_tenant_name_idx').on(t.accountId, t.name),
]);

export const orders = pgTable('orders', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  etsyOrderId: varchar('etsy_order_id', { length: 120 }).notNull(),
  orderDate: timestamp('order_date', { withTimezone: true }).notNull(),
  netPayableAmount: money('net_payable_amount'),
  currency: currency(),
  status: orderStatusEnum('status').default('NEW').notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  notes: text('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('orders_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('orders_amounts_valid', sql`(${t.netPayableAmount} IS NULL OR (${t.netPayableAmount} >= 0 AND ${t.netPayableAmount} < 'Infinity'::numeric))`),
  unique('orders_tenant_currency_uq').on(t.accountId, t.id, t.currency),
  uniqueIndex('orders_tenant_etsy_id_uq').on(t.accountId, t.etsyOrderId),
  unique('orders_tenant_id_uq').on(t.accountId, t.id),
  index('orders_tenant_date_idx').on(t.accountId, t.orderDate),
  index('orders_tenant_status_idx').on(t.accountId, t.status),
  check('orders_net_payable_nonnegative', sql`${t.netPayableAmount} >= 0`),
]);

export const orderItems = pgTable('order_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  orderId: uuid('order_id').notNull(),
  productId: uuid('product_id'),
  productNameSnapshot: varchar('product_name_snapshot', { length: 240 }).notNull(),
  skuSnapshot: varchar('sku_snapshot', { length: 100 }),
  quantity: integer('quantity').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('order_items_tenant_id_uq').on(t.accountId, t.id),
  foreignKey({ columns: [t.accountId, t.orderId], foreignColumns: [orders.accountId, orders.id], name: 'order_items_order_tenant_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.accountId, t.productId], foreignColumns: [products.accountId, products.id], name: 'order_items_product_tenant_fk' }),
  index('order_items_order_idx').on(t.accountId, t.orderId),
  check('order_items_quantity_positive', sql`${t.quantity} > 0`),
]);

export const supplierPurchases = pgTable('supplier_purchases', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  supplierId: uuid('supplier_id').notNull(),
  supplierOrderReference: varchar('supplier_order_reference', { length: 160 }),
  purchaseUrl: text('purchase_url'),
  purchaseDate: timestamp('purchase_date', { withTimezone: true }),
  totalAmount: money('total_amount'),
  currency: currency(),
  status: supplierPurchaseStatusEnum('status').default('DRAFT').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  notes: text('notes'),
}, (t) => [
  check('supplier_purchases_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('supplier_purchases_amounts_valid', sql`(${t.totalAmount} IS NULL OR (${t.totalAmount} >= 0 AND ${t.totalAmount} < 'Infinity'::numeric))`),
  uniqueIndex('supplier_purchase_reference_uq').on(t.accountId, t.supplierId, t.supplierOrderReference),
  unique('supplier_purchases_tenant_currency_uq').on(t.accountId, t.id, t.currency),
  unique('supplier_purchases_tenant_id_uq').on(t.accountId, t.id),
  foreignKey({ columns: [t.accountId, t.supplierId], foreignColumns: [suppliers.accountId, suppliers.id], name: 'supplier_purchases_supplier_tenant_fk' }),
  index('supplier_purchases_tenant_date_idx').on(t.accountId, t.purchaseDate),
  check('supplier_purchase_amount_nonnegative', sql`${t.totalAmount} >= 0`),
  check('supplier_purchase_confirmation_consistent', sql`(${t.status} NOT IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED') OR (${t.confirmedAt} IS NOT NULL AND ${t.purchaseDate} IS NOT NULL)) AND (${t.status} <> 'DRAFT' OR ${t.confirmedAt} IS NULL) AND (${t.confirmedAt} IS NULL OR ${t.purchaseDate} IS NOT NULL)`),
]);

export const supplierPurchaseItems = pgTable('supplier_purchase_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  supplierPurchaseId: uuid('supplier_purchase_id').notNull(),
  orderItemId: uuid('order_item_id').notNull(),
  quantity: integer('quantity').notNull(),
  unitCost: money('unit_cost'),
  totalCost: money('total_cost'),
  currency: currency(),
  createdAt: createdAt(),
}, (t) => [
  check('supplier_purchase_items_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('supplier_purchase_items_amounts_valid', sql`(${t.unitCost} IS NULL OR (${t.unitCost} >= 0 AND ${t.unitCost} < 'Infinity'::numeric)) AND (${t.totalCost} IS NULL OR (${t.totalCost} >= 0 AND ${t.totalCost} < 'Infinity'::numeric))`),
  foreignKey({ columns: [t.accountId, t.supplierPurchaseId, t.currency], foreignColumns: [supplierPurchases.accountId, supplierPurchases.id, supplierPurchases.currency], name: 'supplier_purchase_items_supplierPurchaseId_currency_fk' }),
  foreignKey({ columns: [t.accountId, t.supplierPurchaseId], foreignColumns: [supplierPurchases.accountId, supplierPurchases.id], name: 'supplier_purchase_items_purchase_tenant_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.accountId, t.orderItemId], foreignColumns: [orderItems.accountId, orderItems.id], name: 'supplier_purchase_items_order_item_tenant_fk' }),
  index('supplier_purchase_items_order_item_idx').on(t.accountId, t.orderItemId),
  check('supplier_purchase_item_quantity_positive', sql`${t.quantity} > 0`),
  check('supplier_purchase_item_cost_nonnegative', sql`${t.unitCost} >= 0 AND ${t.totalCost} >= 0`),
]);

export const payoutEligibility = pgTable('payout_eligibility', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  orderId: uuid('order_id').notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull(),
  eligibilityDate: timestamp('eligibility_date', { withTimezone: true }).notNull(),
  status: payoutEligibilityStatusEnum('status').default('PENDING').notNull(),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  check('eligibility_date_valid', sql`${t.eligibilityDate} >= ${t.deliveredAt}`),
  uniqueIndex('payout_eligibility_order_uq').on(t.accountId, t.orderId),
  foreignKey({ columns: [t.accountId, t.orderId], foreignColumns: [orders.accountId, orders.id], name: 'payout_eligibility_order_tenant_fk' }).onDelete('cascade'),
  index('payout_eligibility_due_idx').on(t.accountId, t.status, t.eligibilityDate),
]);

export const payoutBatches = pgTable('payout_batches', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  expectedPayoutDate: date('expected_payout_date').notNull(),
  status: payoutBatchStatusEnum('status').default('EXPECTED').notNull(),
  expectedTotalAmount: money('expected_total_amount'),
  currency: currency(),
  createdAt: createdAt(),
}, (t) => [
  check('payout_batches_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('payout_batches_amounts_valid', sql`(${t.expectedTotalAmount} IS NULL OR (${t.expectedTotalAmount} >= 0 AND ${t.expectedTotalAmount} < 'Infinity'::numeric))`),
  uniqueIndex('payout_batches_schedule_uq').on(t.accountId, t.expectedPayoutDate, t.currency).where(sql`${t.status} <> 'CANCELLED'`),
  unique('payout_batches_tenant_currency_uq').on(t.accountId, t.id, t.currency),
  unique('payout_batches_tenant_id_uq').on(t.accountId, t.id), index('payout_batches_date_idx').on(t.accountId, t.expectedPayoutDate)]);

export const payoutBatchItems = pgTable('payout_batch_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  payoutBatchId: uuid('payout_batch_id').notNull(),
  orderId: uuid('order_id').notNull(),
  expectedAmount: money('expected_amount'),
  currency: currency(),
  createdAt: createdAt(),
}, (t) => [
  check('payout_batch_items_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('payout_batch_items_amounts_valid', sql`(${t.expectedAmount} IS NULL OR (${t.expectedAmount} >= 0 AND ${t.expectedAmount} < 'Infinity'::numeric))`),
  foreignKey({ columns: [t.accountId, t.orderId, t.currency], foreignColumns: [orders.accountId, orders.id, orders.currency], name: 'payout_batch_items_orderId_currency_fk' }),
  foreignKey({ columns: [t.accountId, t.payoutBatchId, t.currency], foreignColumns: [payoutBatches.accountId, payoutBatches.id, payoutBatches.currency], name: 'payout_batch_items_payoutBatchId_currency_fk' }),
  unique('payout_batch_items_tenant_currency_uq').on(t.accountId, t.id, t.currency),
  unique('payout_batch_items_tenant_id_uq').on(t.accountId, t.id),
  foreignKey({ columns: [t.accountId, t.payoutBatchId], foreignColumns: [payoutBatches.accountId, payoutBatches.id], name: 'payout_batch_items_batch_tenant_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.accountId, t.orderId], foreignColumns: [orders.accountId, orders.id], name: 'payout_batch_items_order_tenant_fk' }),
  uniqueIndex('payout_batch_order_uq').on(t.accountId, t.payoutBatchId, t.orderId),
  index('payout_batch_items_order_idx').on(t.accountId, t.orderId),
]);

export const etsyPayouts = pgTable('etsy_payouts', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  externalReference: varchar('external_reference', { length: 160 }),
  payoutDate: timestamp('payout_date', { withTimezone: true }).notNull(),
  actualAmount: money('actual_amount'),
  currency: currency(),
  status: payoutStatusEnum('status').default('RECORDED').notNull(),
  notes: text('notes'),
  createdAt: createdAt(),
}, (t) => [
  check('etsy_payouts_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('etsy_payouts_amounts_valid', sql`(${t.actualAmount} IS NULL OR (${t.actualAmount} >= 0 AND ${t.actualAmount} < 'Infinity'::numeric))`),
  uniqueIndex('etsy_payout_external_reference_uq').on(t.accountId, t.externalReference),
  unique('etsy_payouts_tenant_currency_uq').on(t.accountId, t.id, t.currency),
  unique('etsy_payouts_tenant_id_uq').on(t.accountId, t.id), index('etsy_payouts_date_idx').on(t.accountId, t.payoutDate)]);

export const etsyPayoutAllocations = pgTable('etsy_payout_allocations', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  etsyPayoutId: uuid('etsy_payout_id').notNull(),
  payoutBatchItemId: uuid('payout_batch_item_id').notNull(),
  allocatedAmount: money('allocated_amount'),
  currency: currency(),
  createdAt: createdAt(),
}, (t) => [
  check('etsy_payout_allocations_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('etsy_payout_allocations_amounts_valid', sql`(${t.allocatedAmount} IS NULL OR (${t.allocatedAmount} > 0 AND ${t.allocatedAmount} < 'Infinity'::numeric))`),
  uniqueIndex('etsy_payout_allocation_pair_uq').on(t.accountId, t.etsyPayoutId, t.payoutBatchItemId),
  foreignKey({ columns: [t.accountId, t.payoutBatchItemId, t.currency], foreignColumns: [payoutBatchItems.accountId, payoutBatchItems.id, payoutBatchItems.currency], name: 'etsy_payout_allocations_payoutBatchItemId_currency_fk' }),
  foreignKey({ columns: [t.accountId, t.etsyPayoutId, t.currency], foreignColumns: [etsyPayouts.accountId, etsyPayouts.id, etsyPayouts.currency], name: 'etsy_payout_allocations_etsyPayoutId_currency_fk' }),
  foreignKey({ columns: [t.accountId, t.etsyPayoutId], foreignColumns: [etsyPayouts.accountId, etsyPayouts.id], name: 'etsy_payout_allocations_payout_tenant_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.accountId, t.payoutBatchItemId], foreignColumns: [payoutBatchItems.accountId, payoutBatchItems.id], name: 'etsy_payout_allocations_batch_item_tenant_fk' }),
  index('etsy_payout_allocations_item_idx').on(t.accountId, t.payoutBatchItemId),
]);

export const importJobs = pgTable('import_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  importType: varchar('import_type', { length: 60 }).notNull(),
  filename: text('filename'),
  status: importStatusEnum('status').default('PENDING').notNull(),
  totalRows: integer('total_rows').default(0).notNull(),
  successfulRows: integer('successful_rows').default(0).notNull(),
  failedRows: integer('failed_rows').default(0).notNull(),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  check('import_counts_valid', sql`${t.totalRows} >= 0 AND ${t.successfulRows} >= 0 AND ${t.failedRows} >= 0 AND ${t.successfulRows} + ${t.failedRows} <= ${t.totalRows}`),
  unique('import_jobs_tenant_id_uq').on(t.accountId, t.id), index('import_jobs_status_idx').on(t.accountId, t.status)]);

export const payoneerTransactions = pgTable('payoneer_transactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  externalTransactionId: varchar('external_transaction_id', { length: 180 }),
  transactionDate: timestamp('transaction_date', { withTimezone: true }).notNull(),
  transactionType: transactionTypeEnum('transaction_type').notNull(),
  amount: money('amount'),
  currency: currency(),
  feeAmount: nullableMoney('fee_amount'),
  feeCurrency: varchar('fee_currency', { length: 3 }),
  description: text('description'),
  importJobId: uuid('import_job_id'),
  createdAt: createdAt(),
}, (t) => [
  check('payoneer_transactions_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('payoneer_transactions_amounts_valid', sql`(${t.amount} IS NULL OR (${t.amount} > '-Infinity'::numeric AND ${t.amount} < 'Infinity'::numeric)) AND (${t.feeAmount} IS NULL OR (${t.feeAmount} >= 0 AND ${t.feeAmount} < 'Infinity'::numeric))`),
  check('payoneer_transactions_fee_pair_valid', sql`(${t.feeAmount} IS NULL AND ${t.feeCurrency} IS NULL) OR (${t.feeAmount} IS NOT NULL AND ${t.feeCurrency} IS NOT NULL AND ${t.feeCurrency} ~ '^[A-Z]{3}$')`),
  check('payoneer_transaction_sign_valid', sql`${t.transactionType} IN ('ADJUSTMENT', 'OTHER') OR ${t.amount} > 0`),
  unique('payoneer_transactions_tenant_currency_uq').on(t.accountId, t.id, t.currency),
  uniqueIndex('payoneer_external_tx_uq').on(t.accountId, t.externalTransactionId),
  unique('payoneer_tenant_id_uq').on(t.accountId, t.id),
  foreignKey({ columns: [t.accountId, t.importJobId], foreignColumns: [importJobs.accountId, importJobs.id], name: 'payoneer_import_job_tenant_fk' }),
  index('payoneer_transaction_date_idx').on(t.accountId, t.transactionDate),
]);

export const payoneerReconciliations = pgTable('payoneer_reconciliations', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  payoneerTransactionId: uuid('payoneer_transaction_id').notNull(),
  etsyPayoutId: uuid('etsy_payout_id').notNull(),
  allocatedAmount: money('allocated_amount'),
  currency: currency(),
  status: reconciliationStatusEnum('status').default('SUGGESTED').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  check('payoneer_reconciliations_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('payoneer_reconciliations_amounts_valid', sql`(${t.allocatedAmount} IS NULL OR (${t.allocatedAmount} > 0 AND ${t.allocatedAmount} < 'Infinity'::numeric))`),
  uniqueIndex('payoneer_reconciliation_pair_uq').on(t.accountId, t.payoneerTransactionId, t.etsyPayoutId),
  check('reconciliation_confirmation_consistent', sql`(${t.status} = 'SUGGESTED' AND ${t.confirmedAt} IS NULL) OR (${t.status} IN ('CONFIRMED', 'REVERSED') AND ${t.confirmedAt} IS NOT NULL)`),
  foreignKey({ columns: [t.accountId, t.etsyPayoutId, t.currency], foreignColumns: [etsyPayouts.accountId, etsyPayouts.id, etsyPayouts.currency], name: 'payoneer_reconciliations_etsyPayoutId_currency_fk' }),
  foreignKey({ columns: [t.accountId, t.payoneerTransactionId, t.currency], foreignColumns: [payoneerTransactions.accountId, payoneerTransactions.id, payoneerTransactions.currency], name: 'payoneer_reconciliations_payoneerTransactionId_currency_fk' }),
  foreignKey({ columns: [t.accountId, t.payoneerTransactionId], foreignColumns: [payoneerTransactions.accountId, payoneerTransactions.id], name: 'payoneer_recon_tx_tenant_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.accountId, t.etsyPayoutId], foreignColumns: [etsyPayouts.accountId, etsyPayouts.id], name: 'payoneer_recon_payout_tenant_fk' }),
  index('payoneer_recon_payout_idx').on(t.accountId, t.etsyPayoutId),
]);

export const bankWithdrawals = pgTable('bank_withdrawals', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  payoneerTransactionId: uuid('payoneer_transaction_id').notNull(),
  withdrawalDate: timestamp('withdrawal_date', { withTimezone: true }).notNull(),
  usdAmount: money('usd_amount'),
  actualPkrReceived: money('actual_pkr_received'),
  actualExchangeRate: numeric('actual_exchange_rate', { precision: 19, scale: 8 }).notNull(),
  feeAmount: nullableMoney('fee_amount'),
  feeCurrency: varchar('fee_currency', { length: 3 }),
  bankReference: varchar('bank_reference', { length: 180 }),
  notes: text('notes'),
  createdAt: createdAt(),
}, (t) => [
  check('bank_withdrawals_amounts_valid', sql`(${t.usdAmount} IS NULL OR (${t.usdAmount} >= 0 AND ${t.usdAmount} < 'Infinity'::numeric)) AND (${t.actualPkrReceived} IS NULL OR (${t.actualPkrReceived} >= 0 AND ${t.actualPkrReceived} < 'Infinity'::numeric)) AND (${t.actualExchangeRate} IS NULL OR (${t.actualExchangeRate} > 0 AND ${t.actualExchangeRate} < 'Infinity'::numeric)) AND (${t.feeAmount} IS NULL OR (${t.feeAmount} >= 0 AND ${t.feeAmount} < 'Infinity'::numeric))`),
  check('bank_withdrawals_fee_pair_valid', sql`(${t.feeAmount} IS NULL AND ${t.feeCurrency} IS NULL) OR (${t.feeAmount} IS NOT NULL AND ${t.feeCurrency} IS NOT NULL AND ${t.feeCurrency} ~ '^[A-Z]{3}$')`),
  uniqueIndex('bank_withdrawals_payoneer_tx_uq').on(t.accountId, t.payoneerTransactionId),
  foreignKey({ columns: [t.accountId, t.payoneerTransactionId], foreignColumns: [payoneerTransactions.accountId, payoneerTransactions.id], name: 'bank_withdrawal_payoneer_tx_tenant_fk' }),
  index('bank_withdrawals_date_idx').on(t.accountId, t.withdrawalDate),
  check('bank_withdrawal_positive_amounts', sql`${t.usdAmount} > 0 AND ${t.actualPkrReceived} >= 0 AND ${t.actualExchangeRate} > 0`),
]);

export const expenseCategories = pgTable('expense_categories', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  name: varchar('name', { length: 120 }).notNull(),
  categoryType: varchar('category_type', { length: 40 }).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: createdAt(),
}, (t) => [unique('expense_categories_tenant_id_uq').on(t.accountId, t.id), uniqueIndex('expense_categories_name_uq').on(t.accountId, t.name)]);

export const expenses = pgTable('expenses', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  categoryId: uuid('category_id').notNull(),
  orderId: uuid('order_id'),
  expenseType: expenseTypeEnum('expense_type').notNull(),
  amount: money('amount'),
  currency: currency(),
  expenseDate: timestamp('expense_date', { withTimezone: true }).notNull(),
  description: text('description'),
  sourceReference: varchar('source_reference', { length: 180 }),
  status: recordStatusEnum('status').default('DRAFT').notNull(),
  createdAt: createdAt(),
}, (t) => [
  check('expenses_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('expenses_amounts_valid', sql`(${t.amount} IS NULL OR (${t.amount} >= 0 AND ${t.amount} < 'Infinity'::numeric))`),
  check('expense_scope_consistent', sql`(${t.expenseType} = 'DIRECT' AND ${t.orderId} IS NOT NULL) OR (${t.expenseType} = 'SHARED' AND ${t.orderId} IS NULL)`),
  unique('expenses_tenant_currency_uq').on(t.accountId, t.id, t.currency),
  unique('expenses_tenant_id_uq').on(t.accountId, t.id),
  foreignKey({ columns: [t.accountId, t.categoryId], foreignColumns: [expenseCategories.accountId, expenseCategories.id], name: 'expenses_category_tenant_fk' }),
  foreignKey({ columns: [t.accountId, t.orderId], foreignColumns: [orders.accountId, orders.id], name: 'expenses_order_tenant_fk' }),
  index('expenses_date_idx').on(t.accountId, t.expenseDate),
  index('expenses_type_idx').on(t.accountId, t.expenseType),
]);

export const refunds = pgTable('refunds', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  orderId: uuid('order_id').notNull(),
  refundDate: timestamp('refund_date', { withTimezone: true }).notNull(),
  refundAmount: money('refund_amount'),
  currency: currency(),
  refundType: refundTypeEnum('refund_type').notNull(),
  notes: text('notes'),
  createdAt: createdAt(),
}, (t) => [
  check('refunds_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('refunds_amounts_valid', sql`(${t.refundAmount} IS NULL OR (${t.refundAmount} > 0 AND ${t.refundAmount} < 'Infinity'::numeric))`),
  foreignKey({ columns: [t.accountId, t.orderId, t.currency], foreignColumns: [orders.accountId, orders.id, orders.currency], name: 'refunds_orderId_currency_fk' }),
  unique('refunds_tenant_currency_uq').on(t.accountId, t.id, t.currency),
  unique('refunds_tenant_id_uq').on(t.accountId, t.id),
  foreignKey({ columns: [t.accountId, t.orderId], foreignColumns: [orders.accountId, orders.id], name: 'refunds_order_tenant_fk' }),
  index('refunds_order_idx').on(t.accountId, t.orderId),
]);

export const supplierRefunds = pgTable('supplier_refunds', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  supplierPurchaseId: uuid('supplier_purchase_id').notNull(),
  refundDate: timestamp('refund_date', { withTimezone: true }).notNull(),
  refundAmount: money('refund_amount'),
  currency: currency(),
  externalReference: varchar('external_reference', { length: 180 }),
  notes: text('notes'),
  createdAt: createdAt(),
}, (t) => [
  check('supplier_refunds_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('supplier_refunds_amounts_valid', sql`(${t.refundAmount} IS NULL OR (${t.refundAmount} > 0 AND ${t.refundAmount} < 'Infinity'::numeric))`),
  uniqueIndex('supplier_refund_reference_uq').on(t.accountId, t.supplierPurchaseId, t.externalReference),
  foreignKey({ columns: [t.accountId, t.supplierPurchaseId, t.currency], foreignColumns: [supplierPurchases.accountId, supplierPurchases.id, supplierPurchases.currency], name: 'supplier_refunds_supplierPurchaseId_currency_fk' }),
  foreignKey({ columns: [t.accountId, t.supplierPurchaseId], foreignColumns: [supplierPurchases.accountId, supplierPurchases.id], name: 'supplier_refunds_purchase_tenant_fk' }),
  index('supplier_refunds_purchase_idx').on(t.accountId, t.supplierPurchaseId),
]);

export const refundAdjustments = pgTable('refund_adjustments', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  refundId: uuid('refund_id').notNull(),
  adjustmentType: varchar('adjustment_type', { length: 60 }).notNull(),
  amount: money('amount'),
  currency: currency(),
  description: text('description'),
  createdAt: createdAt(),
}, (t) => [
  index('refund_adjustments_refund_idx').on(t.accountId, t.refundId),
  check('refund_adjustments_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('refund_adjustments_amounts_valid', sql`(${t.amount} IS NULL OR (${t.amount} > '-Infinity'::numeric AND ${t.amount} < 'Infinity'::numeric))`),
  foreignKey({ columns: [t.accountId, t.refundId, t.currency], foreignColumns: [refunds.accountId, refunds.id, refunds.currency], name: 'refund_adjustments_refundId_currency_fk' }),foreignKey({ columns: [t.accountId, t.refundId], foreignColumns: [refunds.accountId, refunds.id], name: 'refund_adjustments_refund_tenant_fk' })]);

export const financialAccounts = pgTable('financial_accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  name: varchar('name', { length: 140 }).notNull(),
  accountRole: financialAccountRoleEnum('account_role').default('UNCLASSIFIED').notNull(),
  accountType: financialAccountTypeEnum('account_type').notNull(),
  currency: currency(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: createdAt(),
}, (t) => [
  check('financial_account_role_type_valid', sql`${t.accountRole} = 'UNCLASSIFIED' OR (${t.accountRole} IN ('ETSY_RECEIVABLE', 'ETSY_PAYOUT_CLEARING', 'PAYONEER', 'BANK', 'TRANSFER_CLEARING') AND ${t.accountType} = 'ASSET') OR (${t.accountRole} IN ('SUPPLIER_COST', 'DIRECT_EXPENSE', 'SHARED_EXPENSE') AND ${t.accountType} = 'EXPENSE') OR (${t.accountRole} = 'REVENUE' AND ${t.accountType} = 'INCOME') OR (${t.accountRole} = 'REFUND' AND ${t.accountType} IN ('INCOME', 'EXPENSE'))`),
  check('financial_accounts_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  unique('financial_accounts_tenant_currency_uq').on(t.accountId, t.id, t.currency),
  unique('financial_accounts_tenant_id_uq').on(t.accountId, t.id), uniqueIndex('financial_accounts_name_currency_uq').on(t.accountId, t.name, t.currency)]);

// Explicit accounting instructions for source types whose treatment is user-defined.
export const financialPostingEvents = pgTable('financial_posting_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  eventKey: varchar('event_key', { length: 180 }).notNull(),
  sourceType: varchar('source_type', { length: 80 }).notNull(),
  sourceId: uuid('source_id').notNull(),
  sourceEvent: varchar('source_event', { length: 100 }).notNull(),
  sourceAmount: money('source_amount'),
  currency: currency(),
  amountBasis: postingAmountBasisEnum('amount_basis').notNull(),
  controlFinancialAccountId: uuid('control_financial_account_id'),
  createdAt: createdAt(),
}, (t) => [
  unique('posting_events_tenant_currency_uq').on(t.accountId, t.id, t.currency),
  uniqueIndex('posting_events_event_key_uq').on(t.accountId, t.eventKey),
  uniqueIndex('posting_events_source_event_uq').on(t.accountId, t.sourceType, t.sourceId, t.sourceEvent, t.currency),
  foreignKey({ columns: [t.accountId, t.controlFinancialAccountId, t.currency], foreignColumns: [financialAccounts.accountId, financialAccounts.id, financialAccounts.currency], name: 'posting_events_control_account_currency_fk' }),
  check('posting_events_keys_valid', sql`length(trim(${t.eventKey})) > 0 AND length(trim(${t.sourceEvent})) > 0 AND ${t.sourceType} IN ('refund_adjustment', 'payoneer_transaction', 'opening_balance', 'adjustment')`),
  check('posting_events_amount_valid', sql`${t.sourceAmount} > '-Infinity'::numeric AND ${t.sourceAmount} < 'Infinity'::numeric`),
  check('posting_events_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('posting_events_basis_valid', sql`(${t.amountBasis} = 'TOTAL_DEBITS' AND ${t.controlFinancialAccountId} IS NULL AND ${t.sourceAmount} > 0) OR (${t.amountBasis} <> 'TOTAL_DEBITS' AND ${t.controlFinancialAccountId} IS NOT NULL)`),
]);

export const financialPostingLegs = pgTable('financial_posting_legs', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  postingEventId: uuid('posting_event_id').notNull(),
  financialAccountId: uuid('financial_account_id').notNull(),
  debitAmount: numeric('debit_amount', { precision: 19, scale: 4 }).default('0').notNull(),
  creditAmount: numeric('credit_amount', { precision: 19, scale: 4 }).default('0').notNull(),
  currency: currency(),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ columns: [t.accountId, t.postingEventId, t.currency], foreignColumns: [financialPostingEvents.accountId, financialPostingEvents.id, financialPostingEvents.currency], name: 'posting_legs_event_tenant_currency_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.accountId, t.financialAccountId, t.currency], foreignColumns: [financialAccounts.accountId, financialAccounts.id, financialAccounts.currency], name: 'posting_legs_account_tenant_currency_fk' }).onDelete('restrict'),
  index('posting_legs_event_idx').on(t.accountId, t.postingEventId),
  index('posting_legs_account_idx').on(t.accountId, t.financialAccountId),
  check('posting_legs_one_side', sql`(${t.debitAmount} > 0 AND ${t.creditAmount} = 0) OR (${t.creditAmount} > 0 AND ${t.debitAmount} = 0)`),
  check('posting_legs_finite', sql`${t.debitAmount} >= 0 AND ${t.creditAmount} >= 0 AND ${t.debitAmount} < 'Infinity'::numeric AND ${t.creditAmount} < 'Infinity'::numeric`),
]);

export const journalEntries = pgTable('journal_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  postingEventId: uuid('posting_event_id'),
  reversalOfEntryId: uuid('reversal_of_entry_id'),
  sourceType: varchar('source_type', { length: 80 }).notNull(),
  sourceId: uuid('source_id'),
  currency: currency(),
  sourceEvent: varchar('source_event', { length: 100 }).default('INITIAL').notNull(),
  transactionDate: timestamp('transaction_date', { withTimezone: true }).notNull(),
  description: text('description'),
  status: journalStatusEnum('status').default('DRAFT').notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 180 }).notNull(),
  createdAt: createdAt(),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ columns: [t.accountId, t.postingEventId, t.currency], foreignColumns: [financialPostingEvents.accountId, financialPostingEvents.id, financialPostingEvents.currency], name: 'journal_posting_event_tenant_currency_fk' }),
  uniqueIndex('journal_posting_event_uq').on(t.accountId, t.postingEventId),
  foreignKey({ columns: [t.accountId, t.reversalOfEntryId, t.currency], foreignColumns: [t.accountId, t.id, t.currency], name: 'journal_reversal_original_tenant_currency_fk' }),
  uniqueIndex('journal_reversal_original_uq').on(t.accountId, t.reversalOfEntryId),
  check('journal_reversal_shape', sql`${t.reversalOfEntryId} IS NULL OR (${t.reversalOfEntryId} <> ${t.id} AND ${t.sourceType} = 'adjustment' AND ${t.sourceEvent} = 'REVERSAL' AND ${t.sourceId} = ${t.reversalOfEntryId})`),
  check('journal_entries_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  uniqueIndex('journal_entries_source_event_uq').on(t.accountId, t.sourceType, t.sourceId, t.sourceEvent, t.currency),
  check('journal_source_required', sql`${t.sourceId} IS NOT NULL AND length(trim(${t.sourceType})) > 0 AND length(trim(${t.sourceEvent})) > 0 AND length(trim(${t.idempotencyKey})) > 0`),
  check('journal_finalization_consistent', sql`(${t.status} = 'DRAFT' AND ${t.finalizedAt} IS NULL) OR (${t.status} IN ('FINALIZED', 'REVERSED') AND ${t.finalizedAt} IS NOT NULL)`),
  unique('journal_entries_tenant_currency_uq').on(t.accountId, t.id, t.currency),
  uniqueIndex('journal_entries_idempotency_uq').on(t.accountId, t.idempotencyKey), unique('journal_entries_tenant_id_uq').on(t.accountId, t.id), index('journal_entries_date_idx').on(t.accountId, t.transactionDate)]);

export const journalLines = pgTable('journal_lines', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  journalEntryId: uuid('journal_entry_id').notNull(),
  financialAccountId: uuid('financial_account_id').notNull(),
  debitAmount: numeric('debit_amount', { precision: 19, scale: 4 }).default('0').notNull(),
  creditAmount: numeric('credit_amount', { precision: 19, scale: 4 }).default('0').notNull(),
  currency: currency(),
  createdAt: createdAt(),
}, (t) => [
  index('journal_lines_financial_account_idx').on(t.accountId, t.financialAccountId),
  check('journal_lines_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('journal_lines_amounts_valid', sql`(${t.debitAmount} IS NULL OR (${t.debitAmount} >= 0 AND ${t.debitAmount} < 'Infinity'::numeric)) AND (${t.creditAmount} IS NULL OR (${t.creditAmount} >= 0 AND ${t.creditAmount} < 'Infinity'::numeric))`),
  foreignKey({ columns: [t.accountId, t.financialAccountId, t.currency], foreignColumns: [financialAccounts.accountId, financialAccounts.id, financialAccounts.currency], name: 'journal_lines_financialAccountId_currency_fk' }),
  foreignKey({ columns: [t.accountId, t.journalEntryId, t.currency], foreignColumns: [journalEntries.accountId, journalEntries.id, journalEntries.currency], name: 'journal_lines_journalEntryId_currency_fk' }),
  foreignKey({ columns: [t.accountId, t.journalEntryId], foreignColumns: [journalEntries.accountId, journalEntries.id], name: 'journal_lines_entry_tenant_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.accountId, t.financialAccountId], foreignColumns: [financialAccounts.accountId, financialAccounts.id], name: 'journal_lines_financial_account_tenant_fk' }),
  check('journal_line_one_side_only', sql`(${t.debitAmount} > 0 AND ${t.creditAmount} = 0) OR (${t.creditAmount} > 0 AND ${t.debitAmount} = 0)`),
  check('journal_line_nonnegative', sql`${t.debitAmount} >= 0 AND ${t.creditAmount} >= 0`),
  index('journal_lines_entry_idx').on(t.accountId, t.journalEntryId),
]);

export const expenseAllocations = pgTable('expense_allocations', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  expenseId: uuid('expense_id').notNull(),
  orderId: uuid('order_id').notNull(),
  reportingPeriodStart: date('reporting_period_start').notNull(),
  reportingPeriodEnd: date('reporting_period_end').notNull(),
  allocationMethod: allocationMethodEnum('allocation_method').notNull(),
  allocatedAmount: money('allocated_amount'),
  currency: currency(),
  calculationSnapshot: jsonb('calculation_snapshot').notNull(),
  createdAt: createdAt(),
}, (t) => [
  check('expense_allocations_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('expense_allocations_amounts_valid', sql`(${t.allocatedAmount} IS NULL OR (${t.allocatedAmount} > 0 AND ${t.allocatedAmount} < 'Infinity'::numeric))`),
  uniqueIndex('expense_allocation_scenario_order_uq').on(t.accountId, t.expenseId, t.orderId, t.reportingPeriodStart, t.reportingPeriodEnd, t.allocationMethod),
  check('expense_allocation_period_valid', sql`${t.reportingPeriodStart} <= ${t.reportingPeriodEnd}`),
  foreignKey({ columns: [t.accountId, t.expenseId, t.currency], foreignColumns: [expenses.accountId, expenses.id, expenses.currency], name: 'expense_allocations_expenseId_currency_fk' }),
  foreignKey({ columns: [t.accountId, t.expenseId], foreignColumns: [expenses.accountId, expenses.id], name: 'expense_allocations_expense_tenant_fk' }),
  foreignKey({ columns: [t.accountId, t.orderId], foreignColumns: [orders.accountId, orders.id], name: 'expense_allocations_order_tenant_fk' }),
  index('expense_allocations_period_idx').on(t.accountId, t.reportingPeriodStart, t.reportingPeriodEnd),
]);

export const exchangeRates = pgTable('exchange_rates', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  baseCurrency: currency('base_currency'),
  quoteCurrency: currency('quote_currency'),
  rate: numeric('rate', { precision: 19, scale: 8 }).notNull(),
  rateDate: date('rate_date').notNull(),
  source: varchar('source', { length: 100 }),
  isManual: boolean('is_manual').default(false).notNull(),
  createdAt: createdAt(),
}, (t) => [
  check('exchange_rates_amounts_valid', sql`(${t.rate} IS NULL OR (${t.rate} > 0 AND ${t.rate} < 'Infinity'::numeric))`),
  check('exchange_currencies_valid', sql`${t.baseCurrency} ~ '^[A-Z]{3}$' AND ${t.quoteCurrency} ~ '^[A-Z]{3}$' AND ${t.baseCurrency} <> ${t.quoteCurrency}`),
  index('exchange_rates_pair_date_idx').on(t.accountId, t.baseCurrency, t.quoteCurrency, t.rateDate), check('exchange_rate_positive', sql`${t.rate} > 0`)]);

export const importRows = pgTable('import_rows', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  importJobId: uuid('import_job_id').notNull(),
  rowNumber: integer('row_number').notNull(),
  rawData: jsonb('raw_data').notNull(),
  normalizedData: jsonb('normalized_data'),
  status: importRowStatusEnum('status').default('PENDING').notNull(),
  errorMessage: text('error_message'),
}, (t) => [
  check('import_row_number_positive', sql`${t.rowNumber} > 0`),
  foreignKey({ columns: [t.accountId, t.importJobId], foreignColumns: [importJobs.accountId, importJobs.id], name: 'import_rows_job_tenant_fk' }).onDelete('cascade'),
  uniqueIndex('import_rows_job_row_uq').on(t.accountId, t.importJobId, t.rowNumber),
]);

export const backgroundJobs = pgTable('background_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  jobType: varchar('job_type', { length: 100 }).notNull(),
  payload: jsonb('payload').notNull().default({}),
  status: backgroundJobStatusEnum('status').default('QUEUED').notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').default(0).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 180 }).notNull(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  check('background_job_attempts_valid', sql`${t.attempts} >= 0 AND length(trim(${t.idempotencyKey})) > 0`),
  uniqueIndex('background_jobs_idempotency_uq').on(t.accountId, t.idempotencyKey), index('background_jobs_dispatch_idx').on(t.status, t.scheduledAt)]);

export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  notificationType: varchar('notification_type', { length: 80 }).notNull(),
  title: varchar('title', { length: 180 }).notNull(),
  message: text('message').notNull(),
  referenceType: varchar('reference_type', { length: 80 }),
  referenceId: uuid('reference_id'),
  isRead: boolean('is_read').default(false).notNull(),
  createdAt: createdAt(),
}, (t) => [index('notifications_unread_idx').on(t.accountId, t.isRead, t.createdAt)]);

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  userId: text('user_id'),
  entityType: varchar('entity_type', { length: 100 }).notNull(),
  entityId: uuid('entity_id'),
  action: varchar('action', { length: 60 }).notNull(),
  beforeData: jsonb('before_data'),
  afterData: jsonb('after_data'),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ columns: [t.accountId, t.userId], foreignColumns: [businessAccounts.id, businessAccounts.ownerUserId], name: 'audit_logs_owner_tenant_fk' }),
  index('audit_logs_entity_idx').on(t.accountId, t.entityType, t.entityId), index('audit_logs_created_idx').on(t.accountId, t.createdAt)]);

// Operational shipping is separate from order-level delivery/payout decisions.
export const shipments = pgTable('shipments', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  orderId: uuid('order_id').notNull(),
  carrier: varchar('carrier', { length: 120 }),
  trackingNumber: varchar('tracking_number', { length: 180 }),
  trackingUrl: text('tracking_url'),
  shipmentStatus: shipmentStatusEnum('shipment_status').default('PENDING').notNull(),
  shippedAt: timestamp('shipped_at', { withTimezone: true }),
  estimatedDeliveryAt: timestamp('estimated_delivery_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  notes: text('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('shipments_tenant_id_uq').on(t.accountId, t.id),
  foreignKey({ columns: [t.accountId, t.orderId], foreignColumns: [orders.accountId, orders.id], name: 'shipments_order_tenant_fk' }).onDelete('restrict'),
  index('shipments_order_idx').on(t.accountId, t.orderId),
  index('shipments_tracking_idx').on(t.accountId, t.carrier, t.trackingNumber),
  index('shipments_status_idx').on(t.accountId, t.shipmentStatus, t.estimatedDeliveryAt),
  check('shipment_delivery_dates_valid', sql`${t.deliveredAt} IS NULL OR (${t.shippedAt} IS NOT NULL AND ${t.deliveredAt} >= ${t.shippedAt})`),
  check('shipment_delivered_status_valid', sql`${t.shipmentStatus} <> 'DELIVERED' OR ${t.deliveredAt} IS NOT NULL`),
]);

export const shipmentEvents = pgTable('shipment_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: tenantId(),
  shipmentId: uuid('shipment_id').notNull(),
  eventSequence: integer('event_sequence').generatedAlwaysAsIdentity(),
  eventType: shipmentEventTypeEnum('event_type').notNull(),
  eventDate: timestamp('event_date', { withTimezone: true }).notNull(),
  description: text('description'),
  location: varchar('location', { length: 180 }),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ columns: [t.accountId, t.shipmentId], foreignColumns: [shipments.accountId, shipments.id], name: 'shipment_events_shipment_tenant_fk' }).onDelete('restrict'),
  index('shipment_events_history_idx').on(t.accountId, t.shipmentId, t.eventSequence),
  index('shipment_events_date_idx').on(t.accountId, t.shipmentId, t.eventDate),
]);

// Suggested inferred types for service/repository layers.
export type BusinessAccount = typeof businessAccounts.$inferSelect;
export type NewBusinessAccount = typeof businessAccounts.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type SupplierPurchase = typeof supplierPurchases.$inferSelect;
export type NewSupplierPurchase = typeof supplierPurchases.$inferInsert;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;
