CREATE TYPE "public"."posting_amount_basis" AS ENUM('TOTAL_DEBITS', 'NET_DEBIT', 'NET_CREDIT');--> statement-breakpoint
CREATE TABLE "financial_posting_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"event_key" varchar(180) NOT NULL,
	"source_type" varchar(80) NOT NULL,
	"source_id" uuid NOT NULL,
	"source_event" varchar(100) NOT NULL,
	"source_amount" numeric(19, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"amount_basis" "posting_amount_basis" NOT NULL,
	"control_financial_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_events_tenant_currency_uq" UNIQUE("account_id","id","currency"),
	CONSTRAINT "posting_events_keys_valid" CHECK (length(trim("financial_posting_events"."event_key")) > 0 AND length(trim("financial_posting_events"."source_event")) > 0 AND "financial_posting_events"."source_type" IN ('refund_adjustment', 'payoneer_transaction', 'opening_balance', 'adjustment')),
	CONSTRAINT "posting_events_amount_valid" CHECK ("financial_posting_events"."source_amount" > '-Infinity'::numeric AND "financial_posting_events"."source_amount" < 'Infinity'::numeric),
	CONSTRAINT "posting_events_currency_valid" CHECK ("financial_posting_events"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "posting_events_basis_valid" CHECK (("financial_posting_events"."amount_basis" = 'TOTAL_DEBITS' AND "financial_posting_events"."control_financial_account_id" IS NULL AND "financial_posting_events"."source_amount" > 0) OR ("financial_posting_events"."amount_basis" <> 'TOTAL_DEBITS' AND "financial_posting_events"."control_financial_account_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "financial_posting_legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"posting_event_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"debit_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"currency" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_legs_one_side" CHECK (("financial_posting_legs"."debit_amount" > 0 AND "financial_posting_legs"."credit_amount" = 0) OR ("financial_posting_legs"."credit_amount" > 0 AND "financial_posting_legs"."debit_amount" = 0)),
	CONSTRAINT "posting_legs_finite" CHECK ("financial_posting_legs"."debit_amount" >= 0 AND "financial_posting_legs"."credit_amount" >= 0 AND "financial_posting_legs"."debit_amount" < 'Infinity'::numeric AND "financial_posting_legs"."credit_amount" < 'Infinity'::numeric)
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "posting_event_id" uuid;--> statement-breakpoint
ALTER TABLE "financial_posting_events" ADD CONSTRAINT "financial_posting_events_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_posting_events" ADD CONSTRAINT "posting_events_control_account_currency_fk" FOREIGN KEY ("account_id","control_financial_account_id","currency") REFERENCES "public"."financial_accounts"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_posting_legs" ADD CONSTRAINT "financial_posting_legs_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_posting_legs" ADD CONSTRAINT "posting_legs_event_tenant_currency_fk" FOREIGN KEY ("account_id","posting_event_id","currency") REFERENCES "public"."financial_posting_events"("account_id","id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_posting_legs" ADD CONSTRAINT "posting_legs_account_tenant_currency_fk" FOREIGN KEY ("account_id","financial_account_id","currency") REFERENCES "public"."financial_accounts"("account_id","id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "posting_events_event_key_uq" ON "financial_posting_events" USING btree ("account_id","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "posting_events_source_event_uq" ON "financial_posting_events" USING btree ("account_id","source_type","source_id","source_event","currency");--> statement-breakpoint
CREATE INDEX "posting_legs_event_idx" ON "financial_posting_legs" USING btree ("account_id","posting_event_id");--> statement-breakpoint
CREATE INDEX "posting_legs_account_idx" ON "financial_posting_legs" USING btree ("account_id","financial_account_id");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_posting_event_tenant_currency_fk" FOREIGN KEY ("account_id","posting_event_id","currency") REFERENCES "public"."financial_posting_events"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_posting_event_uq" ON "journal_entries" USING btree ("account_id","posting_event_id");