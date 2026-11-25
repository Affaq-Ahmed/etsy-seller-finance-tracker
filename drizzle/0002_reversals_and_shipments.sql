CREATE TYPE "public"."shipment_event_type" AS ENUM('PENDING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'EXCEPTION', 'RETURNED', 'CANCELLED', 'NOTE');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('PENDING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'EXCEPTION', 'RETURNED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "shipment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"event_sequence" integer GENERATED ALWAYS AS IDENTITY (sequence name "shipment_events_event_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_type" "shipment_event_type" NOT NULL,
	"event_date" timestamp with time zone NOT NULL,
	"description" text,
	"location" varchar(180),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"carrier" varchar(120),
	"tracking_number" varchar(180),
	"tracking_url" text,
	"shipment_status" "shipment_status" DEFAULT 'PENDING' NOT NULL,
	"shipped_at" timestamp with time zone,
	"estimated_delivery_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_tenant_id_uq" UNIQUE("account_id","id"),
	CONSTRAINT "shipment_delivery_dates_valid" CHECK ("shipments"."delivered_at" IS NULL OR ("shipments"."shipped_at" IS NOT NULL AND "shipments"."delivered_at" >= "shipments"."shipped_at")),
	CONSTRAINT "shipment_delivered_status_valid" CHECK ("shipments"."shipment_status" <> 'DELIVERED' OR "shipments"."delivered_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "reversal_of_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_tenant_fk" FOREIGN KEY ("account_id","shipment_id") REFERENCES "public"."shipments"("account_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_tenant_fk" FOREIGN KEY ("account_id","order_id") REFERENCES "public"."orders"("account_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipment_events_history_idx" ON "shipment_events" USING btree ("account_id","shipment_id","event_sequence");--> statement-breakpoint
CREATE INDEX "shipment_events_date_idx" ON "shipment_events" USING btree ("account_id","shipment_id","event_date");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("account_id","order_id");--> statement-breakpoint
CREATE INDEX "shipments_tracking_idx" ON "shipments" USING btree ("account_id","carrier","tracking_number");--> statement-breakpoint
CREATE INDEX "shipments_status_idx" ON "shipments" USING btree ("account_id","shipment_status","estimated_delivery_at");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_reversal_original_tenant_currency_fk" FOREIGN KEY ("account_id","reversal_of_entry_id","currency") REFERENCES "public"."journal_entries"("account_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_reversal_original_uq" ON "journal_entries" USING btree ("account_id","reversal_of_entry_id");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_reversal_shape" CHECK ("journal_entries"."reversal_of_entry_id" IS NULL OR ("journal_entries"."reversal_of_entry_id" <> "journal_entries"."id" AND "journal_entries"."source_type" = 'adjustment' AND "journal_entries"."source_event" = 'REVERSAL' AND "journal_entries"."source_id" = "journal_entries"."reversal_of_entry_id"));