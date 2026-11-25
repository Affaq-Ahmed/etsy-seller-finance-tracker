CREATE TYPE "public"."allocation_method" AS ENUM('PROPORTIONAL', 'EQUAL', 'MANUAL', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."background_job_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."expense_type" AS ENUM('DIRECT', 'SHARED');--> statement-breakpoint
CREATE TYPE "public"."financial_account_type" AS ENUM('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');--> statement-breakpoint
CREATE TYPE "public"."import_row_status" AS ENUM('PENDING', 'VALID', 'IMPORTED', 'DUPLICATE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."journal_status" AS ENUM('DRAFT', 'FINALIZED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('NEW', 'SUPPLIER_ORDERED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'PAYOUT_ELIGIBLE', 'PAYOUT_SCHEDULED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."payout_batch_status" AS ENUM('EXPECTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'ADJUSTED');--> statement-breakpoint
CREATE TYPE "public"."payout_eligibility_status" AS ENUM('PENDING', 'ELIGIBLE', 'ON_HOLD', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."etsy_payout_status" AS ENUM('RECORDED', 'PARTIALLY_ALLOCATED', 'ALLOCATED', 'ADJUSTED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('SUGGESTED', 'CONFIRMED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."record_status" AS ENUM('DRAFT', 'CONFIRMED', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."refund_type" AS ENUM('FULL', 'PARTIAL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."supplier_purchase_status" AS ENUM('DRAFT', 'CONFIRMED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."payoneer_transaction_type" AS ENUM('DEPOSIT', 'WITHDRAWAL', 'FEE', 'ADJUSTMENT', 'OTHER');--> statement-breakpoint
CREATE TABLE "account_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"setting_key" varchar(100) NOT NULL,
	"setting_value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" text,
	"entity_type" varchar(100) NOT NULL,
	"entity_id" uuid,
	"action" varchar(60) NOT NULL,
	"before_data" jsonb,
	"after_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"job_type" varchar(100) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "background_job_status" DEFAULT 'QUEUED' NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" varchar(180) NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "background_job_attempts_valid" CHECK ("background_jobs"."attempts" >= 0 AND length(trim("background_jobs"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "bank_withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"payoneer_transaction_id" uuid NOT NULL,
	"withdrawal_date" timestamp with time zone NOT NULL,
	"usd_amount" numeric(19, 4) NOT NULL,
	"actual_pkr_received" numeric(19, 4) NOT NULL,
	"actual_exchange_rate" numeric(19, 8) NOT NULL,
	"fee_amount" numeric(19, 4),
	"fee_currency" varchar(3),
	"bank_reference" varchar(180),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_withdrawals_amounts_valid" CHECK (("bank_withdrawals"."usd_amount" IS NULL OR ("bank_withdrawals"."usd_amount" >= 0 AND "bank_withdrawals"."usd_amount" < 'Infinity'::numeric)) AND ("bank_withdrawals"."actual_pkr_received" IS NULL OR ("bank_withdrawals"."actual_pkr_received" >= 0 AND "bank_withdrawals"."actual_pkr_received" < 'Infinity'::numeric)) AND ("bank_withdrawals"."actual_exchange_rate" IS NULL OR ("bank_withdrawals"."actual_exchange_rate" > 0 AND "bank_withdrawals"."actual_exchange_rate" < 'Infinity'::numeric)) AND ("bank_withdrawals"."fee_amount" IS NULL OR ("bank_withdrawals"."fee_amount" >= 0 AND "bank_withdrawals"."fee_amount" < 'Infinity'::numeric))),
	CONSTRAINT "bank_withdrawals_fee_pair_valid" CHECK (("bank_withdrawals"."fee_amount" IS NULL AND "bank_withdrawals"."fee_currency" IS NULL) OR ("bank_withdrawals"."fee_amount" IS NOT NULL AND "bank_withdrawals"."fee_currency" IS NOT NULL AND "bank_withdrawals"."fee_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "bank_withdrawal_positive_amounts" CHECK ("bank_withdrawals"."usd_amount" > 0 AND "bank_withdrawals"."actual_pkr_received" >= 0 AND "bank_withdrawals"."actual_exchange_rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "business_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"shop_name" varchar(160) NOT NULL,
	"base_currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"timezone" varchar(80) DEFAULT 'Asia/Karachi' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_accounts_owner_pair_uq" UNIQUE("id","owner_user_id"),
	CONSTRAINT "business_base_currency_valid" CHECK ("business_accounts"."base_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "etsy_payout_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"etsy_payout_id" uuid NOT NULL,
	"payout_batch_item_id" uuid NOT NULL,
	"allocated_amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "etsy_payout_allocations_currency_valid" CHECK ("etsy_payout_allocations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "etsy_payout_allocations_amounts_valid" CHECK (("etsy_payout_allocations"."allocated_amount" IS NULL OR ("etsy_payout_allocations"."allocated_amount" > 0 AND "etsy_payout_allocations"."allocated_amount" < 'Infinity'::numeric)))
);
--> statement-breakpoint
CREATE TABLE "etsy_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_reference" varchar(160),
	"payout_date" timestamp with time zone NOT NULL,
	"actual_amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "etsy_payout_status" DEFAULT 'RECORDED' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "etsy_payouts_tenant_currency_uq" UNIQUE("account_id","id","currency"),
	CONSTRAINT "etsy_payouts_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "etsy_payouts_currency_valid" CHECK ("etsy_payouts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "etsy_payouts_amounts_valid" CHECK (("etsy_payouts"."actual_amount" IS NULL OR ("etsy_payouts"."actual_amount" >= 0 AND "etsy_payouts"."actual_amount" < 'Infinity'::numeric)))
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"base_currency" varchar(3) NOT NULL,
	"quote_currency" varchar(3) NOT NULL,
	"rate" numeric(19, 8) NOT NULL,
	"rate_date" date NOT NULL,
	"source" varchar(100),
	"is_manual" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_amounts_valid" CHECK (("exchange_rates"."rate" IS NULL OR ("exchange_rates"."rate" > 0 AND "exchange_rates"."rate" < 'Infinity'::numeric))),
	CONSTRAINT "exchange_currencies_valid" CHECK ("exchange_rates"."base_currency" ~ '^[A-Z]{3}$' AND "exchange_rates"."quote_currency" ~ '^[A-Z]{3}$' AND "exchange_rates"."base_currency" <> "exchange_rates"."quote_currency"),
	CONSTRAINT "exchange_rate_positive" CHECK ("exchange_rates"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "expense_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"reporting_period_start" date NOT NULL,
	"reporting_period_end" date NOT NULL,
	"allocation_method" "allocation_method" NOT NULL,
	"allocated_amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"calculation_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_allocations_currency_valid" CHECK ("expense_allocations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "expense_allocations_amounts_valid" CHECK (("expense_allocations"."allocated_amount" IS NULL OR ("expense_allocations"."allocated_amount" > 0 AND "expense_allocations"."allocated_amount" < 'Infinity'::numeric))),
	CONSTRAINT "expense_allocation_period_valid" CHECK ("expense_allocations"."reporting_period_start" <= "expense_allocations"."reporting_period_end")
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"category_type" varchar(40) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_categories_tenant_id_uq" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"order_id" uuid,
	"expense_type" "expense_type" NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"expense_date" timestamp with time zone NOT NULL,
	"description" text,
	"source_reference" varchar(180),
	"status" "record_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_tenant_currency_uq" UNIQUE("account_id","id","currency"),
	CONSTRAINT "expenses_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "expenses_currency_valid" CHECK ("expenses"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "expenses_amounts_valid" CHECK (("expenses"."amount" IS NULL OR ("expenses"."amount" >= 0 AND "expenses"."amount" < 'Infinity'::numeric))),
	CONSTRAINT "expense_scope_consistent" CHECK (("expenses"."expense_type" = 'DIRECT' AND "expenses"."order_id" IS NOT NULL) OR ("expenses"."expense_type" = 'SHARED' AND "expenses"."order_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "financial_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(140) NOT NULL,
	"account_type" "financial_account_type" NOT NULL,
	"currency" varchar(3) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_accounts_tenant_currency_uq" UNIQUE("account_id","id","currency"),
	CONSTRAINT "financial_accounts_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "financial_accounts_currency_valid" CHECK ("financial_accounts"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"import_type" varchar(60) NOT NULL,
	"filename" text,
	"status" "import_status" DEFAULT 'PENDING' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"successful_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "import_jobs_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "import_counts_valid" CHECK ("import_jobs"."total_rows" >= 0 AND "import_jobs"."successful_rows" >= 0 AND "import_jobs"."failed_rows" >= 0 AND "import_jobs"."successful_rows" + "import_jobs"."failed_rows" <= "import_jobs"."total_rows")
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"import_job_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw_data" jsonb NOT NULL,
	"normalized_data" jsonb,
	"status" "import_row_status" DEFAULT 'PENDING' NOT NULL,
	"error_message" text,
	CONSTRAINT "import_row_number_positive" CHECK ("import_rows"."row_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"source_type" varchar(80) NOT NULL,
	"source_id" uuid,
	"currency" varchar(3) NOT NULL,
	"source_event" varchar(100) DEFAULT 'INITIAL' NOT NULL,
	"transaction_date" timestamp with time zone NOT NULL,
	"description" text,
	"status" "journal_status" DEFAULT 'DRAFT' NOT NULL,
	"idempotency_key" varchar(180) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "journal_entries_tenant_currency_uq" UNIQUE("account_id","id","currency"),
	CONSTRAINT "journal_entries_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "journal_entries_currency_valid" CHECK ("journal_entries"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "journal_source_required" CHECK ("journal_entries"."source_id" IS NOT NULL AND length(trim("journal_entries"."source_type")) > 0 AND length(trim("journal_entries"."source_event")) > 0 AND length(trim("journal_entries"."idempotency_key")) > 0),
	CONSTRAINT "journal_finalization_consistent" CHECK (("journal_entries"."status" = 'DRAFT' AND "journal_entries"."finalized_at" IS NULL) OR ("journal_entries"."status" IN ('FINALIZED', 'REVERSED') AND "journal_entries"."finalized_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"debit_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"currency" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_currency_valid" CHECK ("journal_lines"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "journal_lines_amounts_valid" CHECK (("journal_lines"."debit_amount" IS NULL OR ("journal_lines"."debit_amount" >= 0 AND "journal_lines"."debit_amount" < 'Infinity'::numeric)) AND ("journal_lines"."credit_amount" IS NULL OR ("journal_lines"."credit_amount" >= 0 AND "journal_lines"."credit_amount" < 'Infinity'::numeric))),
	CONSTRAINT "journal_line_one_side_only" CHECK (("journal_lines"."debit_amount" > 0 AND "journal_lines"."credit_amount" = 0) OR ("journal_lines"."credit_amount" > 0 AND "journal_lines"."debit_amount" = 0)),
	CONSTRAINT "journal_line_nonnegative" CHECK ("journal_lines"."debit_amount" >= 0 AND "journal_lines"."credit_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"notification_type" varchar(80) NOT NULL,
	"title" varchar(180) NOT NULL,
	"message" text NOT NULL,
	"reference_type" varchar(80),
	"reference_id" uuid,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"product_name_snapshot" varchar(240) NOT NULL,
	"sku_snapshot" varchar(100),
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "order_items_quantity_positive" CHECK ("order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"etsy_order_id" varchar(120) NOT NULL,
	"order_date" timestamp with time zone NOT NULL,
	"net_payable_amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "order_status" DEFAULT 'NEW' NOT NULL,
	"delivered_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_tenant_currency_uq" UNIQUE("account_id","id","currency"),
	CONSTRAINT "orders_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "orders_currency_valid" CHECK ("orders"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_amounts_valid" CHECK (("orders"."net_payable_amount" IS NULL OR ("orders"."net_payable_amount" >= 0 AND "orders"."net_payable_amount" < 'Infinity'::numeric))),
	CONSTRAINT "orders_net_payable_nonnegative" CHECK ("orders"."net_payable_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payoneer_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"payoneer_transaction_id" uuid NOT NULL,
	"etsy_payout_id" uuid NOT NULL,
	"allocated_amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "reconciliation_status" DEFAULT 'SUGGESTED' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payoneer_reconciliations_currency_valid" CHECK ("payoneer_reconciliations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payoneer_reconciliations_amounts_valid" CHECK (("payoneer_reconciliations"."allocated_amount" IS NULL OR ("payoneer_reconciliations"."allocated_amount" > 0 AND "payoneer_reconciliations"."allocated_amount" < 'Infinity'::numeric))),
	CONSTRAINT "reconciliation_confirmation_consistent" CHECK (("payoneer_reconciliations"."status" = 'SUGGESTED' AND "payoneer_reconciliations"."confirmed_at" IS NULL) OR ("payoneer_reconciliations"."status" IN ('CONFIRMED', 'REVERSED') AND "payoneer_reconciliations"."confirmed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payoneer_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_transaction_id" varchar(180),
	"transaction_date" timestamp with time zone NOT NULL,
	"transaction_type" "payoneer_transaction_type" NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"fee_amount" numeric(19, 4),
	"fee_currency" varchar(3),
	"description" text,
	"import_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payoneer_transactions_tenant_currency_uq" UNIQUE("account_id","id","currency"),
	CONSTRAINT "payoneer_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "payoneer_transactions_currency_valid" CHECK ("payoneer_transactions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payoneer_transactions_amounts_valid" CHECK (("payoneer_transactions"."amount" IS NULL OR ("payoneer_transactions"."amount" > '-Infinity'::numeric AND "payoneer_transactions"."amount" < 'Infinity'::numeric)) AND ("payoneer_transactions"."fee_amount" IS NULL OR ("payoneer_transactions"."fee_amount" >= 0 AND "payoneer_transactions"."fee_amount" < 'Infinity'::numeric))),
	CONSTRAINT "payoneer_transactions_fee_pair_valid" CHECK (("payoneer_transactions"."fee_amount" IS NULL AND "payoneer_transactions"."fee_currency" IS NULL) OR ("payoneer_transactions"."fee_amount" IS NOT NULL AND "payoneer_transactions"."fee_currency" IS NOT NULL AND "payoneer_transactions"."fee_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "payoneer_transaction_sign_valid" CHECK ("payoneer_transactions"."transaction_type" IN ('ADJUSTMENT', 'OTHER') OR "payoneer_transactions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payout_batch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"payout_batch_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"expected_amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_batch_items_tenant_currency_uq" UNIQUE("account_id","id","currency"),
	CONSTRAINT "payout_batch_items_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "payout_batch_items_currency_valid" CHECK ("payout_batch_items"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payout_batch_items_amounts_valid" CHECK (("payout_batch_items"."expected_amount" IS NULL OR ("payout_batch_items"."expected_amount" >= 0 AND "payout_batch_items"."expected_amount" < 'Infinity'::numeric)))
);
--> statement-breakpoint
CREATE TABLE "payout_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"expected_payout_date" date NOT NULL,
	"status" "payout_batch_status" DEFAULT 'EXPECTED' NOT NULL,
	"expected_total_amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_batches_tenant_currency_uq" UNIQUE("account_id","id","currency"),
	CONSTRAINT "payout_batches_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "payout_batches_currency_valid" CHECK ("payout_batches"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payout_batches_amounts_valid" CHECK (("payout_batches"."expected_total_amount" IS NULL OR ("payout_batches"."expected_total_amount" >= 0 AND "payout_batches"."expected_total_amount" < 'Infinity'::numeric)))
);
--> statement-breakpoint
CREATE TABLE "payout_eligibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL,
	"eligibility_date" timestamp with time zone NOT NULL,
	"status" "payout_eligibility_status" DEFAULT 'PENDING' NOT NULL,
	"evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eligibility_date_valid" CHECK ("payout_eligibility"."eligibility_date" >= "payout_eligibility"."delivered_at")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(240) NOT NULL,
	"sku" varchar(100),
	"image_url" text,
	"default_supplier_id" uuid,
	"default_unit_cost" numeric(19, 4),
	"currency" varchar(3) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "products_currency_valid" CHECK ("products"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "products_amounts_valid" CHECK (("products"."default_unit_cost" IS NULL OR ("products"."default_unit_cost" >= 0 AND "products"."default_unit_cost" < 'Infinity'::numeric)))
);
--> statement-breakpoint
CREATE TABLE "refund_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"adjustment_type" varchar(60) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_adjustments_currency_valid" CHECK ("refund_adjustments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "refund_adjustments_amounts_valid" CHECK (("refund_adjustments"."amount" IS NULL OR ("refund_adjustments"."amount" > '-Infinity'::numeric AND "refund_adjustments"."amount" < 'Infinity'::numeric)))
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"refund_date" timestamp with time zone NOT NULL,
	"refund_amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"refund_type" "refund_type" NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_tenant_currency_uq" UNIQUE("account_id","id","currency"),
	CONSTRAINT "refunds_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "refunds_currency_valid" CHECK ("refunds"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "refunds_amounts_valid" CHECK (("refunds"."refund_amount" IS NULL OR ("refunds"."refund_amount" > 0 AND "refunds"."refund_amount" < 'Infinity'::numeric)))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_purchase_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"supplier_purchase_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(19, 4) NOT NULL,
	"total_cost" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_purchase_items_currency_valid" CHECK ("supplier_purchase_items"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "supplier_purchase_items_amounts_valid" CHECK (("supplier_purchase_items"."unit_cost" IS NULL OR ("supplier_purchase_items"."unit_cost" >= 0 AND "supplier_purchase_items"."unit_cost" < 'Infinity'::numeric)) AND ("supplier_purchase_items"."total_cost" IS NULL OR ("supplier_purchase_items"."total_cost" >= 0 AND "supplier_purchase_items"."total_cost" < 'Infinity'::numeric))),
	CONSTRAINT "supplier_purchase_item_quantity_positive" CHECK ("supplier_purchase_items"."quantity" > 0),
	CONSTRAINT "supplier_purchase_item_cost_nonnegative" CHECK ("supplier_purchase_items"."unit_cost" >= 0 AND "supplier_purchase_items"."total_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_order_reference" varchar(160),
	"purchase_url" text,
	"purchase_date" timestamp with time zone,
	"total_amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "supplier_purchase_status" DEFAULT 'DRAFT' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	CONSTRAINT "supplier_purchases_tenant_currency_uq" UNIQUE("account_id","id","currency"),
	CONSTRAINT "supplier_purchases_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "supplier_purchases_currency_valid" CHECK ("supplier_purchases"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "supplier_purchases_amounts_valid" CHECK (("supplier_purchases"."total_amount" IS NULL OR ("supplier_purchases"."total_amount" >= 0 AND "supplier_purchases"."total_amount" < 'Infinity'::numeric))),
	CONSTRAINT "supplier_purchase_amount_nonnegative" CHECK ("supplier_purchases"."total_amount" >= 0),
	CONSTRAINT "supplier_purchase_confirmation_consistent" CHECK (("supplier_purchases"."status" NOT IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED') OR ("supplier_purchases"."confirmed_at" IS NOT NULL AND "supplier_purchases"."purchase_date" IS NOT NULL)) AND ("supplier_purchases"."status" <> 'DRAFT' OR "supplier_purchases"."confirmed_at" IS NULL) AND ("supplier_purchases"."confirmed_at" IS NULL OR "supplier_purchases"."purchase_date" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "supplier_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"supplier_purchase_id" uuid NOT NULL,
	"refund_date" timestamp with time zone NOT NULL,
	"refund_amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"external_reference" varchar(180),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_refunds_currency_valid" CHECK ("supplier_refunds"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "supplier_refunds_amounts_valid" CHECK (("supplier_refunds"."refund_amount" IS NULL OR ("supplier_refunds"."refund_amount" > 0 AND "supplier_refunds"."refund_amount" < 'Infinity'::numeric)))
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(180) NOT NULL,
	"marketplace" varchar(40) NOT NULL,
	"website_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_tenant_id_uq" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_owner_tenant_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."business_accounts"("id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_withdrawals" ADD CONSTRAINT "bank_withdrawals_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_withdrawals" ADD CONSTRAINT "bank_withdrawal_payoneer_tx_tenant_fk" FOREIGN KEY ("account_id","payoneer_transaction_id") REFERENCES "public"."payoneer_transactions"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_accounts" ADD CONSTRAINT "business_accounts_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etsy_payout_allocations" ADD CONSTRAINT "etsy_payout_allocations_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etsy_payout_allocations" ADD CONSTRAINT "etsy_payout_allocations_payoutBatchItemId_currency_fk" FOREIGN KEY ("account_id","payout_batch_item_id","currency") REFERENCES "public"."payout_batch_items"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etsy_payout_allocations" ADD CONSTRAINT "etsy_payout_allocations_etsyPayoutId_currency_fk" FOREIGN KEY ("account_id","etsy_payout_id","currency") REFERENCES "public"."etsy_payouts"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etsy_payout_allocations" ADD CONSTRAINT "etsy_payout_allocations_payout_tenant_fk" FOREIGN KEY ("account_id","etsy_payout_id") REFERENCES "public"."etsy_payouts"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etsy_payout_allocations" ADD CONSTRAINT "etsy_payout_allocations_batch_item_tenant_fk" FOREIGN KEY ("account_id","payout_batch_item_id") REFERENCES "public"."payout_batch_items"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etsy_payouts" ADD CONSTRAINT "etsy_payouts_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_expenseId_currency_fk" FOREIGN KEY ("account_id","expense_id","currency") REFERENCES "public"."expenses"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_expense_tenant_fk" FOREIGN KEY ("account_id","expense_id") REFERENCES "public"."expenses"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_order_tenant_fk" FOREIGN KEY ("account_id","order_id") REFERENCES "public"."orders"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_tenant_fk" FOREIGN KEY ("account_id","category_id") REFERENCES "public"."expense_categories"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_order_tenant_fk" FOREIGN KEY ("account_id","order_id") REFERENCES "public"."orders"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_job_tenant_fk" FOREIGN KEY ("account_id","import_job_id") REFERENCES "public"."import_jobs"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_financialAccountId_currency_fk" FOREIGN KEY ("account_id","financial_account_id","currency") REFERENCES "public"."financial_accounts"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journalEntryId_currency_fk" FOREIGN KEY ("account_id","journal_entry_id","currency") REFERENCES "public"."journal_entries"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_tenant_fk" FOREIGN KEY ("account_id","journal_entry_id") REFERENCES "public"."journal_entries"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_financial_account_tenant_fk" FOREIGN KEY ("account_id","financial_account_id") REFERENCES "public"."financial_accounts"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_tenant_fk" FOREIGN KEY ("account_id","order_id") REFERENCES "public"."orders"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_tenant_fk" FOREIGN KEY ("account_id","product_id") REFERENCES "public"."products"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payoneer_reconciliations" ADD CONSTRAINT "payoneer_reconciliations_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payoneer_reconciliations" ADD CONSTRAINT "payoneer_reconciliations_etsyPayoutId_currency_fk" FOREIGN KEY ("account_id","etsy_payout_id","currency") REFERENCES "public"."etsy_payouts"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payoneer_reconciliations" ADD CONSTRAINT "payoneer_reconciliations_payoneerTransactionId_currency_fk" FOREIGN KEY ("account_id","payoneer_transaction_id","currency") REFERENCES "public"."payoneer_transactions"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payoneer_reconciliations" ADD CONSTRAINT "payoneer_recon_tx_tenant_fk" FOREIGN KEY ("account_id","payoneer_transaction_id") REFERENCES "public"."payoneer_transactions"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payoneer_reconciliations" ADD CONSTRAINT "payoneer_recon_payout_tenant_fk" FOREIGN KEY ("account_id","etsy_payout_id") REFERENCES "public"."etsy_payouts"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payoneer_transactions" ADD CONSTRAINT "payoneer_transactions_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payoneer_transactions" ADD CONSTRAINT "payoneer_import_job_tenant_fk" FOREIGN KEY ("account_id","import_job_id") REFERENCES "public"."import_jobs"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_batch_items" ADD CONSTRAINT "payout_batch_items_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_batch_items" ADD CONSTRAINT "payout_batch_items_orderId_currency_fk" FOREIGN KEY ("account_id","order_id","currency") REFERENCES "public"."orders"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_batch_items" ADD CONSTRAINT "payout_batch_items_payoutBatchId_currency_fk" FOREIGN KEY ("account_id","payout_batch_id","currency") REFERENCES "public"."payout_batches"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_batch_items" ADD CONSTRAINT "payout_batch_items_batch_tenant_fk" FOREIGN KEY ("account_id","payout_batch_id") REFERENCES "public"."payout_batches"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_batch_items" ADD CONSTRAINT "payout_batch_items_order_tenant_fk" FOREIGN KEY ("account_id","order_id") REFERENCES "public"."orders"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_eligibility" ADD CONSTRAINT "payout_eligibility_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_eligibility" ADD CONSTRAINT "payout_eligibility_order_tenant_fk" FOREIGN KEY ("account_id","order_id") REFERENCES "public"."orders"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_tenant_fk" FOREIGN KEY ("account_id","default_supplier_id") REFERENCES "public"."suppliers"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_adjustments" ADD CONSTRAINT "refund_adjustments_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_adjustments" ADD CONSTRAINT "refund_adjustments_refundId_currency_fk" FOREIGN KEY ("account_id","refund_id","currency") REFERENCES "public"."refunds"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_adjustments" ADD CONSTRAINT "refund_adjustments_refund_tenant_fk" FOREIGN KEY ("account_id","refund_id") REFERENCES "public"."refunds"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_orderId_currency_fk" FOREIGN KEY ("account_id","order_id","currency") REFERENCES "public"."orders"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_tenant_fk" FOREIGN KEY ("account_id","order_id") REFERENCES "public"."orders"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_purchase_items" ADD CONSTRAINT "supplier_purchase_items_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_purchase_items" ADD CONSTRAINT "supplier_purchase_items_supplierPurchaseId_currency_fk" FOREIGN KEY ("account_id","supplier_purchase_id","currency") REFERENCES "public"."supplier_purchases"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_purchase_items" ADD CONSTRAINT "supplier_purchase_items_purchase_tenant_fk" FOREIGN KEY ("account_id","supplier_purchase_id") REFERENCES "public"."supplier_purchases"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_purchase_items" ADD CONSTRAINT "supplier_purchase_items_order_item_tenant_fk" FOREIGN KEY ("account_id","order_item_id") REFERENCES "public"."order_items"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_purchases" ADD CONSTRAINT "supplier_purchases_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_purchases" ADD CONSTRAINT "supplier_purchases_supplier_tenant_fk" FOREIGN KEY ("account_id","supplier_id") REFERENCES "public"."suppliers"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_supplierPurchaseId_currency_fk" FOREIGN KEY ("account_id","supplier_purchase_id","currency") REFERENCES "public"."supplier_purchases"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_purchase_tenant_fk" FOREIGN KEY ("account_id","supplier_purchase_id") REFERENCES "public"."supplier_purchases"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_settings_key_uq" ON "account_settings" USING btree ("account_id","setting_key");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("account_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_account_provider_uq" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_idempotency_uq" ON "background_jobs" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "background_jobs_dispatch_idx" ON "background_jobs" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_withdrawals_payoneer_tx_uq" ON "bank_withdrawals" USING btree ("account_id","payoneer_transaction_id");--> statement-breakpoint
CREATE INDEX "bank_withdrawals_date_idx" ON "bank_withdrawals" USING btree ("account_id","withdrawal_date");--> statement-breakpoint
CREATE UNIQUE INDEX "business_accounts_owner_uq" ON "business_accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "etsy_payout_allocation_pair_uq" ON "etsy_payout_allocations" USING btree ("account_id","etsy_payout_id","payout_batch_item_id");--> statement-breakpoint
CREATE INDEX "etsy_payout_allocations_item_idx" ON "etsy_payout_allocations" USING btree ("account_id","payout_batch_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "etsy_payout_external_reference_uq" ON "etsy_payouts" USING btree ("account_id","external_reference");--> statement-breakpoint
CREATE INDEX "etsy_payouts_date_idx" ON "etsy_payouts" USING btree ("account_id","payout_date");--> statement-breakpoint
CREATE INDEX "exchange_rates_pair_date_idx" ON "exchange_rates" USING btree ("account_id","base_currency","quote_currency","rate_date");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_allocation_scenario_order_uq" ON "expense_allocations" USING btree ("account_id","expense_id","order_id","reporting_period_start","reporting_period_end","allocation_method");--> statement-breakpoint
CREATE INDEX "expense_allocations_period_idx" ON "expense_allocations" USING btree ("account_id","reporting_period_start","reporting_period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_name_uq" ON "expense_categories" USING btree ("account_id","name");--> statement-breakpoint
CREATE INDEX "expenses_date_idx" ON "expenses" USING btree ("account_id","expense_date");--> statement-breakpoint
CREATE INDEX "expenses_type_idx" ON "expenses" USING btree ("account_id","expense_type");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_accounts_name_currency_uq" ON "financial_accounts" USING btree ("account_id","name","currency");--> statement-breakpoint
CREATE INDEX "import_jobs_status_idx" ON "import_jobs" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_job_row_uq" ON "import_rows" USING btree ("account_id","import_job_id","row_number");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_source_event_uq" ON "journal_entries" USING btree ("account_id","source_type","source_id","source_event","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_idempotency_uq" ON "journal_entries" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "journal_entries_date_idx" ON "journal_entries" USING btree ("account_id","transaction_date");--> statement-breakpoint
CREATE INDEX "journal_lines_financial_account_idx" ON "journal_lines" USING btree ("account_id","financial_account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "journal_lines" USING btree ("account_id","journal_entry_id");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("account_id","is_read","created_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("account_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_etsy_id_uq" ON "orders" USING btree ("account_id","etsy_order_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_date_idx" ON "orders" USING btree ("account_id","order_date");--> statement-breakpoint
CREATE INDEX "orders_tenant_status_idx" ON "orders" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payoneer_reconciliation_pair_uq" ON "payoneer_reconciliations" USING btree ("account_id","payoneer_transaction_id","etsy_payout_id");--> statement-breakpoint
CREATE INDEX "payoneer_recon_payout_idx" ON "payoneer_reconciliations" USING btree ("account_id","etsy_payout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payoneer_external_tx_uq" ON "payoneer_transactions" USING btree ("account_id","external_transaction_id");--> statement-breakpoint
CREATE INDEX "payoneer_transaction_date_idx" ON "payoneer_transactions" USING btree ("account_id","transaction_date");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_batch_order_uq" ON "payout_batch_items" USING btree ("account_id","payout_batch_id","order_id");--> statement-breakpoint
CREATE INDEX "payout_batch_items_order_idx" ON "payout_batch_items" USING btree ("account_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_batches_schedule_uq" ON "payout_batches" USING btree ("account_id","expected_payout_date","currency") WHERE "payout_batches"."status" <> 'CANCELLED';--> statement-breakpoint
CREATE INDEX "payout_batches_date_idx" ON "payout_batches" USING btree ("account_id","expected_payout_date");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_eligibility_order_uq" ON "payout_eligibility" USING btree ("account_id","order_id");--> statement-breakpoint
CREATE INDEX "payout_eligibility_due_idx" ON "payout_eligibility" USING btree ("account_id","status","eligibility_date");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_sku_uq" ON "products" USING btree ("account_id","sku");--> statement-breakpoint
CREATE INDEX "products_tenant_name_idx" ON "products" USING btree ("account_id","name");--> statement-breakpoint
CREATE INDEX "refund_adjustments_refund_idx" ON "refund_adjustments" USING btree ("account_id","refund_id");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("account_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_uq" ON "session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "supplier_purchase_items_order_item_idx" ON "supplier_purchase_items" USING btree ("account_id","order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_purchase_reference_uq" ON "supplier_purchases" USING btree ("account_id","supplier_id","supplier_order_reference");--> statement-breakpoint
CREATE INDEX "supplier_purchases_tenant_date_idx" ON "supplier_purchases" USING btree ("account_id","purchase_date");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_refund_reference_uq" ON "supplier_refunds" USING btree ("account_id","supplier_purchase_id","external_reference");--> statement-breakpoint
CREATE INDEX "supplier_refunds_purchase_idx" ON "supplier_refunds" USING btree ("account_id","supplier_purchase_id");--> statement-breakpoint
CREATE INDEX "suppliers_tenant_name_idx" ON "suppliers" USING btree ("account_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_uq" ON "user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");