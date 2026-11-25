# Etsy Payment Tracker SaaS
## System Architecture Document v1.1

**Status:** Updated  
**Date:** November 23, 2026  
**Architecture Style:** Modular Monolith  
**Primary Constraint:** Zero mandatory operating cost

---

## 1. Architecture Overview

The application will use a modular monolithic architecture.

A single Next.js application will contain:
- Frontend.
- Authentication.
- API endpoints.
- Business logic.
- Financial calculations.
- Import processing.
- Reporting.
- Background job orchestration.

Microservices are unnecessary for the initial product and would add deployment and operational complexity.

## 2. Technology Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js + TypeScript |
| UI | Tailwind CSS + shadcn/ui |
| Forms | React Hook Form |
| Validation | Zod |
| Charts | Recharts |
| Backend | Next.js Route Handlers |
| Database | PostgreSQL |
| Database Provider | Neon Free |
| ORM | Drizzle ORM |
| Authentication | Better Auth |
| Hosting | Cloudflare Workers Free |
| Deployment Adapter | OpenNext |
| Background Jobs | PostgreSQL job queue |
| Scheduler | Cloudflare Cron Triggers |
| Source Control | GitHub Free |
| Email | Optional Brevo Free |
| Testing | Vitest + Playwright |

All application dependencies should be open-source or available without mandatory payment.

## 3. Hosting and Infrastructure

### 3.1 Cloudflare Workers

The production application will run on Cloudflare Workers.

Reasons:
- Free hosting tier.
- No mandatory server subscription.
- Free `workers.dev` subdomain.
- Built-in scheduled triggers.
- Edge deployment.

Published Free plan limits include 100,000 requests per day and 10 ms CPU time per request.

These limits require careful implementation. Heavy calculations and imports must be processed in small batches.

### 3.2 Next.js Deployment

Use OpenNext to deploy Next.js on Cloudflare Workers after validating compatibility with the application's required features.

Cloudflare currently recommends evaluating vinext for new projects. However, the existing Next.js architecture favors OpenNext initially because it is designed to support established Next.js functionality.

Before production deployment, test:
- App Router.
- Route Handlers.
- Authentication and cookies.
- Database connectivity.
- Server-side rendering.
- Middleware and server actions, if used.

Do not assume every Next.js feature is supported identically in the Workers runtime.

### 3.3 PostgreSQL

Use Neon Free.

Published free-tier limits include:
- 1 GB storage per project.
- 100 compute hours per month.
- 5 GB public network transfer per project.

No paid upgrade or automatic overage should be enabled.

If the database reaches its free quota, the application must report the issue and stop affected writes safely.

## 4. Application Modules

Organize the codebase into these business domains:

1. Authentication
2. Tenant and account management
3. Orders
4. Products
5. Suppliers
6. Supplier purchases
7. Etsy payout eligibility
8. Etsy payout batches
9. Payoneer transactions
10. Payoneer reconciliation
11. Bank withdrawals
12. Expenses
13. Refunds
14. Financial engine
15. Expense allocation
16. Reports and analytics
17. Shipment tracking
18. Notifications
19. Imports and exports
20. Audit logging
21. Background jobs

Each module should have its own services, schemas, repositories, and validation rules.

## 5. Database Architecture

PostgreSQL is the source of truth.

Use Drizzle ORM for schema definitions and migrations.

### Core Tables

**Identity and tenancy**
- users
- sessions
- accounts
- account_settings

**Orders and products**
- orders
- order_items
- products
- suppliers
- supplier_purchases
- supplier_purchase_items

**Payout lifecycle**
- payout_eligibility
- payout_batches
- payout_batch_items
- etsy_payouts
- etsy_payout_items

**Payoneer and bank**
- payoneer_transactions
- payout_reconciliations
- bank_withdrawals

**Financial management**
- expenses
- expense_categories
- refunds
- refund_adjustments
- financial_accounts
- journal_entries
- journal_lines
- expense_allocations
- exchange_rates

**Platform operations**
- audit_logs
- import_jobs
- import_rows
- background_jobs
- notifications

All business tables must include an account/tenant identifier.

The tenant identifier must be derived from the authenticated session, never trusted from client input.

Use database constraints and indexes to enforce data integrity and improve query performance.

## 6. Financial Architecture

Financial records must be designed around an append-only transaction history.

### 6.1 Ledger

Use a lightweight double-entry journal for finalized financial movements.

Each journal entry:
- Has a source event.
- Has a transaction date.
- Has a currency.
- Contains balanced debit and credit lines.
- Cannot be edited after finalization.

Corrections must create new adjustment entries.

Do not mix USD and PKR within a single balanced journal entry.

### 6.2 Financial Lifecycle

The system must distinguish these events:

1. Etsy order recorded.
2. Delivery confirmed.
3. 14-day eligibility reached.
4. Expected Monday payout batch created.
5. Actual Etsy payout recorded.
6. Payoneer deposit recorded.
7. Payoneer transaction reconciled.
8. Payoneer withdrawal recorded.
9. PKR bank receipt confirmed.

These events must remain separate.

A Payoneer deposit can reconcile against multiple Etsy payouts. Partial and unmatched balances must be supported.

A bank withdrawal is a transfer, not an expense. Only associated fees and actual conversion gains or losses affect business profitability.

### 6.3 Profit Engine

Maintain separate calculations for:
- Direct order profit.
- Business profit.
- Business-adjusted order profit.
- Expected profit.
- Realized profit.
- Cash profit.

Shared expense allocation must be reproducible and traceable to its reporting period and allocation method.

## 7. Background Processing

Do not introduce Inngest, Trigger.dev, or another external job service.

Use a PostgreSQL-backed job queue and one Cloudflare Cron Trigger to dispatch due work.

The queue should support:
- Job type.
- Payload.
- Scheduled time.
- Status.
- Retry count.
- Last error.
- Idempotency key.
- Lock/claim metadata.

Jobs include:
- Payout eligibility checks.
- Monday payout batch generation.
- Overdue shipment alerts.
- Expected payout reminders.
- CSV/Excel import processing.
- Reconciliation suggestions.
- Notification generation.

Jobs must be idempotent. A retry must never create duplicate financial entries or payout batches.

Keep each execution short and process large workloads in chunks to respect Workers CPU limits.

## 8. Authentication and Security

Use Better Auth with email/password authentication.

Security requirements:
- Secure password hashing.
- Session-based authentication.
- Server-side authorization.
- Tenant-level data isolation.
- Input validation.
- Rate limiting.
- CSRF protection where applicable.
- Secure cookies.
- Audit logging.
- No sensitive customer data collection.

Do not expose database credentials or secrets to the browser.

## 9. Email and Notifications

In-app notifications are the default.

Brevo Free may be used for transactional email after verifying:
- Free-plan eligibility.
- Sender identity requirements.
- Sender authentication requirements.
- Delivery limits.

Do not make essential application functionality dependent on an unverified email service.

If free email delivery is unavailable, the application must continue working with in-app notifications.

## 10. Imports and Exports

Support CSV and Excel imports for:
- Payoneer transactions.
- Products.
- Orders, where applicable.

Import workflow:
1. Upload file.
2. Parse and validate.
3. Preview rows.
4. Detect duplicates.
5. Identify invalid records.
6. Confirm import.
7. Record import results.

Exports:
- CSV.
- Excel.

No paid file-processing service.

## 11. API Structure

Use versioned Route Handler endpoints.

Examples:

- `/api/v1/orders`
- `/api/v1/products`
- `/api/v1/suppliers`
- `/api/v1/payouts`
- `/api/v1/payoneer`
- `/api/v1/reconciliation`
- `/api/v1/withdrawals`
- `/api/v1/expenses`
- `/api/v1/refunds`
- `/api/v1/reports`
- `/api/v1/imports`
- `/api/v1/notifications`

Keep business rules in domain services rather than directly inside Route Handlers.

## 12. Testing Strategy

Use:
- Vitest for unit and integration tests.
- Playwright for end-to-end tests.

Critical test scenarios:
- Tenant isolation.
- Duplicate transaction imports.
- 14-day payout eligibility.
- Monday payout batching.
- Partial Etsy payouts.
- Multiple payouts reconciled to one Payoneer deposit.
- Partial refunds.
- USD/PKR conversions.
- Shared expense allocation.
- Ledger balancing.
- Idempotent background jobs.

Financial calculations require dedicated automated tests.

## 13. Deployment and Environments

Use GitHub for source control.

Recommended workflow:
- Local development.
- Automated tests.
- Preview/staging deployment where supported by the free tier.
- Manual production deployment.

Do not introduce paid CI/CD services.

Use environment variables for secrets and separate database credentials for environments.

## 14. Zero-Cost Operating Rules

The following are non-negotiable:

1. No paid hosting.
2. No paid database plan.
3. No paid API dependency.
4. No paid authentication service.
5. No paid job orchestration service.
6. No paid monitoring service.
7. No automatic plan upgrades.
8. No automatic paid overages.
9. No custom domain purchase.
10. No paid email dependency.

Use free-tier quotas with fail-closed behavior.

Do not attach a payment method unless absolutely required and explicitly approved.

If a provider changes its free-tier terms, reassess the architecture before continuing.

## 15. Backup and Recovery

Provide manual database export and restore procedures.

Users must be able to export their business data.

Do not rely on a paid cloud backup service. Keep periodic database backups in user-controlled storage.

Test restore procedures before production release.

## 16. Future Integrations

Possible future additions:
- Etsy API.
- Payoneer API.
- Supplier marketplace APIs.
- Automated shipment tracking.
- Advanced forecasting.

These integrations must be evaluated against the zero-cost requirement before adoption.

## 17. Architecture Decision Summary

| Decision | Selected Approach |
|---|---|
| Architecture | Modular monolith |
| Frontend/backend | Next.js |
| Hosting | Cloudflare Workers Free |
| Deployment adapter | OpenNext, subject to compatibility tests |
| Database | Neon Free PostgreSQL |
| ORM | Drizzle |
| Authentication | Better Auth |
| Background jobs | PostgreSQL queue + Cloudflare Cron |
| UI | shadcn/ui |
| Email | Optional Brevo Free |
| Source control | GitHub Free |
| Domain | workers.dev |
| Billing | None |

**Final Architecture Principle:** Build a financially reliable Etsy seller management system that can operate on free infrastructure, never silently incur charges, and preserve the ability to migrate providers if free-tier conditions change.

## Database hardening implementation note (2026-11-24)

[Financial Posting Rules](Financial_Posting_Rules.md) defines standard source legs, explicit declarations for ambiguous events, tenant/currency validation and immutable atomic reversals. [Shipment Tracking](Shipment_Tracking.md) adds manual shipments and append-only events independently of order delivery/payout eligibility. These are schema/trigger implementations, not completed route handlers or domain services. [Better Auth Compatibility](Better_Auth_Compatibility.md) records the exact version-specific field review and unresolved tooling/runtime validation. Run the complete forward migration chain; do not use schema push to omit custom SQL guards. No production database was accessed for this work.
