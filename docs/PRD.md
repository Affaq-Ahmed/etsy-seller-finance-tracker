# Etsy Payment Tracker SaaS
## Product Requirements Document (PRD) v1.2

**Status:** Updated  
**Date:** November 23, 2026  
**Product Type:** Multi-tenant SaaS  
**Primary Currency:** USD  
**Secondary Currency:** PKR

---

## 1. Product Overview

Etsy Payment Tracker is a financial and operational management platform for Etsy sellers.

It helps sellers track orders, supplier purchases, Etsy payouts, Payoneer transactions, bank withdrawals, expenses, refunds, and business profitability.

The application will initially support manual data entry and CSV/Excel imports. Direct Etsy and Payoneer API integrations are outside the initial scope.

### Core Objective

Give Etsy sellers a reliable picture of:
- How much they are expected to receive.
- How much they have actually received.
- How much they have spent.
- How much profit they have generated.
- How much money is currently held in Etsy, Payoneer, or their bank.

## 2. Target Users and Account Structure

- Multiple Etsy sellers can register independently.
- Each account represents one Etsy shop.
- Only the account owner can access their data.
- No team members or role-based access in V1.
- Every business record must belong to its owner's account.
- No customer personal information will be collected or stored.

Etsy Order ID will be the primary external order reference.

## 3. Functional Requirements

### 3.1 Authentication
- Email and password registration.
- Login and logout.
- Password reset, subject to free email delivery availability.
- Secure password hashing.
- Session management.
- No paid authentication provider.

### 3.2 Order Management
Support quick-entry and detailed-entry order forms.

Each order should contain:
- Etsy Order ID.
- Order date.
- Etsy net payable amount.
- Currency.
- Delivery date.
- Order status.
- Notes.

**Important:** Store only the amount Etsy will pay the seller. Do not require gross customer order value or individual Etsy fees.

Support:
- Single-product orders.
- Multi-product orders.
- Multiple items and quantities.
- Direct supplier cost tracking.
- Order-level expenses.
- Full and partial refunds.

No customer names, addresses, emails, or phone numbers.

### 3.3 Supplier Management

Support:
- eBay.
- Amazon.
- AliExpress.
- Custom suppliers.

Record:
- Supplier name and marketplace.
- Supplier order reference.
- Purchase URL.
- Purchase date.
- Purchase amount and currency.
- Notes.

One Etsy order may have multiple supplier purchases.

### 3.4 Etsy Payout Management

The system must distinguish expected payouts from actual payouts.

Business rules:
1. An order becomes payout-eligible after successful delivery and 14 elapsed days.
2. Eligible orders are grouped into the expected Monday payout batch.
3. Actual Etsy payout recording is separate from expected payout calculation.
4. Actual payout dates and amounts can differ from expectations.
5. Support partial payouts, adjustments, missing payouts, and manual corrections.

The 14-day period and Monday schedule must be configurable.

### 3.5 Payoneer Management

Support:
- Manual transaction entry.
- CSV/Excel transaction imports.
- Duplicate transaction detection.
- Deposit and withdrawal tracking.
- Payoneer fees.
- Manual reconciliation.

A Payoneer deposit may contain funds from multiple Etsy payouts.

A Payoneer withdrawal can be any amount and does not need to correspond to individual Etsy orders.

Payoneer fees are shared business expenses by default.

### 3.6 Bank Withdrawals

Track Payoneer-to-Pakistani-bank withdrawals.

Record:
- Withdrawal date.
- USD amount.
- Actual PKR received.
- Actual exchange rate.
- Payoneer fee.
- Bank reference.
- Notes.

A withdrawal is a transfer between business accounts, not an expense. Only its associated fee is an expense.

### 3.7 Expense Management

Support:
- Etsy advertisements.
- Marketplace subscriptions.
- Software subscriptions.
- Shipping.
- Refund-related expenses.
- Payoneer fees.
- Miscellaneous expenses.
- Custom categories.

Expenses can be classified as:
- Direct order expenses.
- Shared business expenses.

### 3.8 Refund Management

Support:
- Full refunds.
- Partial refunds.
- Supplier refunds.
- Non-refundable fees.
- Manual refund recording.

Refunds must automatically adjust relevant financial calculations through adjustment entries.

### 3.9 Product Management

- Manual product creation.
- Bulk CSV/Excel import.
- Product name and SKU.
- Product image URL.
- Supplier information.
- Cost information.
- Product-to-order association.

No traditional inventory management in V1.

### 3.10 Shipment Tracking

Manual tracking of:
- Carrier.
- Tracking number.
- Shipment date.
- Delivery date.
- Delivery status.
- Notes.

No paid tracking API.

### 3.11 Dashboard and Analytics

Provide financial and operational dashboards.

Metrics include:
- Total Etsy net payable.
- Expected payouts.
- Actual Etsy payouts.
- Payoneer balance.
- Bank withdrawals.
- Total supplier costs.
- Direct and shared expenses.
- Refunds.
- Direct order profit.
- Business-adjusted profit.
- Cash profit.
- Profit margins.
- Product performance.
- Sales trends.
- Delayed shipments.
- Unmatched transactions.

### 3.12 Reporting

Date filters:
- Today.
- Yesterday.
- Last 7 days.
- This week.
- Last 30 days.
- This month.
- Previous month.
- Yearly.
- Custom range.

Provide:
- Interactive reports.
- CSV exports.
- Excel exports.

PDF reporting is deferred.

Reports must support both:
1. Order-date perspective.
2. Cash-date perspective.

## 4. Financial Calculation Rules

### Direct Order Profit

`Etsy Net Payable - Supplier Costs - Direct Order Expenses`

### Business Profit

`Total Direct Order Profit - Shared Business Expenses`

### Business-Adjusted Order Profit

Direct order profit minus its analytical allocation of shared expenses.

Default allocation method: proportional to each order's Etsy net payable amount during the selected reporting period.

Other supported methods:
- Equal.
- Manual.
- Custom.

Allocation is analytical only. It must never create a second expense or double-count shared costs.

Reports must distinguish:
- Expected profit.
- Realized profit.
- Cash profit.
- Direct order profit.
- Business-adjusted profit.

### Financial Integrity

- Finalized financial transactions are immutable.
- Corrections use adjustment entries.
- Every financial record has an audit trail.
- All amounts use exact decimal arithmetic.
- Every amount has an explicit currency.
- USD and PKR must never be added together without conversion.

## 5. Notifications

In-app alerts for:
- Overdue unshipped orders.
- Delayed deliveries.
- Refunds.
- Negative-profit orders.
- Missing expected Etsy payouts.
- Unmatched Payoneer transactions.
- Upcoming subscription renewals.

Email notifications are optional and depend on a verified free email sender.

## 6. Technology Requirements

- Next.js with TypeScript.
- PostgreSQL.
- Drizzle ORM.
- Better Auth.
- Tailwind CSS.
- shadcn/ui.
- React Hook Form.
- Zod.
- Recharts.
- Cloudflare Workers hosting.
- Neon PostgreSQL Free.

## 7. Zero-Cost Requirement

The application must be designed to operate without mandatory paid services.

Rules:
- No paid APIs.
- No paid authentication provider.
- No paid database plan.
- No paid background-job service.
- No paid monitoring service.
- No paid hosting plan.
- No mandatory custom domain.
- No automatic upgrades or paid overages.
- No payment method added merely to unlock application functionality.

Use free-tier services and open-source software.

If a provider's free quota is exhausted, the application must fail safely or pause the affected functionality rather than incur charges.

The application will use a free `workers.dev` address initially.

**Important:** Free-tier availability and terms can change. Permanent zero-cost operation cannot be guaranteed by any external provider.

## 8. Non-Functional Requirements

- Secure multi-tenant isolation.
- Responsive PWA interface.
- Light and dark themes.
- Strong validation.
- Import duplicate detection.
- Financial audit logs.
- Idempotent background jobs.
- Graceful handling of provider limits.
- Exportable user data.
- Manual backup and restore procedures.

## 9. Out of Scope for V1

- Direct Etsy API integration.
- Direct Payoneer API integration.
- Automated supplier ordering.
- Automated shipment tracking APIs.
- Inventory management.
- Team accounts.
- Paid subscriptions and billing.
- AI-powered analytics.
- Native mobile applications.

## 10. Release Strategy

V1 includes all requirements in this document.

Implementation can be delivered in phases, but the agreed product scope remains the complete V1 rather than a reduced MVP.

**Success Criteria:** A seller can manually manage the complete financial lifecycle of an Etsy order, from order creation through supplier purchase, delivery, Etsy payout, Payoneer receipt, bank withdrawal, and final profitability reporting.