# Product

**Last updated:** 2026-11-25
**Product:** Etsy Seller Finance Tracker (PRD title: "Etsy Payment Tracker SaaS"), a multi-tenant SaaS
**Currencies:** USD (primary), PKR (secondary)

This is the baseline product document: scope, user journeys, business and financial rules, acceptance criteria and product decisions. Architecture lives in [ARCHITECTURE.md](ARCHITECTURE.md), setup and workflow in [DEVELOPMENT.md](DEVELOPMENT.md), and progress in [STATUS.md](STATUS.md).

## Source-of-truth hierarchy

1. **Implemented database constraints:** `src/db/schema.ts`, migrations `drizzle/0000–0009` and their tests are authoritative for what the database enforces.
2. **Baseline documents:** `PRODUCT.md`, `ARCHITECTURE.md`, `DEVELOPMENT.md`, `STATUS.md`.
3. **Owner reference specifications**, kept unchanged as originally provided:
   - [PRD v1.2](PRD.md) (2026-11-23): the complete V1 requirements.
   - [System Architecture v1.1](System_Architecture.md) (2026-11-23).
   - [Database ERD v1.2](Database_ERD.md) (2026-11-24).

This document consolidates PRD v1.2 and records clarifications and decisions made since. For any detail it does not restate, PRD v1.2 applies. If this document, the PRD and the implementation disagree, **stop and ask the owner**. Do not pick an interpretation.

---

## 1. Product summary (PRD §1)

The product helps Etsy sellers manually manage the full financial lifecycle of an order: Etsy order → supplier purchase → delivery → Etsy payout → Payoneer receipt → Pakistani bank withdrawal → profitability reporting. V1 relies on manual entry and CSV/Excel imports. There are no Etsy or Payoneer APIs.

The core questions it answers:
- How much the seller expects to receive, and how much they have actually received.
- How much they have spent, and how much profit they have made.
- How much money is held in Etsy, Payoneer and the bank.

## 2. Users and tenancy (PRD §2)

- Sellers self-register. **One user owns exactly one business (tenant), and each business represents one Etsy shop.** There are no team members and no roles in V1.
- Every business record belongs to its owner's tenant. Only the owner can access it.
- **No customer (buyer) personal data** is collected or stored: no names, addresses, emails or phone numbers. The Etsy Order ID is the only external order reference.

## 3. V1 scope

V1 is the complete PRD v1.2 scope, delivered in phases (PRD §10). The summary below shows where each area is specified.

| Area | PRD | Key requirements |
| --- | --- | --- |
| Authentication | §3.1 | Email and password registration, login, logout; password reset (subject to free email); secure hashing; sessions; no paid auth provider |
| Orders | §3.2 | Quick and detailed entry; Etsy Order ID, order date, **Etsy net payable**, currency, delivery date, status, notes; multiple items and quantities; direct costs; order-level expenses; full and partial refunds |
| Suppliers | §3.3 | eBay, Amazon, AliExpress, custom. Supplier order reference, URL, date, amount, currency, notes. Many purchases per order |
| Etsy payouts | §3.4 | Expected payouts kept separate from actual payouts; eligibility after delivery + 14 days; expected Monday batch; **both values configurable**; partial, adjusted, missing and corrected payouts |
| Payoneer | §3.5 | Manual entry and CSV/Excel import, duplicate detection, deposits, withdrawals, fees, manual reconciliation. A deposit may aggregate several payouts |
| Bank withdrawals | §3.6 | Date, USD amount, actual PKR received, actual rate, Payoneer fee, bank reference, notes |
| Expenses | §3.7 | Ads, subscriptions, shipping, refund-related, Payoneer fees, miscellaneous, custom categories; DIRECT or SHARED |
| Refunds | §3.8 | Full, partial, supplier refunds, non-refundable fees, manual refunds; adjust calculations through adjustment entries |
| Products | §3.9 | Manual and bulk import, name, SKU, image URL, supplier, cost, order association; no inventory |
| Shipment tracking | §3.10 | Manual carrier, tracking number, ship and delivery dates, status, notes; no paid tracking API |
| Dashboard | §3.11 | The full metric list in PRD §3.11 |
| Reporting | §3.12 | Date presets plus a custom range; order-date **and** cash-date perspectives; interactive reports; CSV and Excel export (PDF deferred) |
| Notifications | §5 | In-app alerts (overdue unshipped, delayed delivery, refunds, negative profit, missing payouts, unmatched Payoneer, renewals); email optional |
| Non-functional | §8 | Tenant isolation, responsive PWA, light and dark themes, validation, import duplicate detection, audit logs, idempotent jobs, graceful provider limits, data export, manual backup and restore |

**Out of scope for V1 (PRD §9):** Etsy, Payoneer and supplier APIs; automated supplier ordering; automated tracking APIs; inventory; team accounts; paid subscriptions or billing; AI analytics; native mobile apps.

## 4. User journeys

These are derived from PRD v1.2 (the §10 success criterion and §3). The screens and flows themselves are not yet designed.

1. **Register and onboard.** Sign up with email and password, sign in, then create the single business (shop) and get a working set of financial accounts. *Implemented 2026-11-25 (ARCHITECTURE.md §7.2).* Sign-up never signs the user in, so a duplicate registration reveals nothing.
2. **Record an order.** Enter the Etsy Order ID, net payable amount, currency, items and quantities, and optionally link products.
3. **Buy from a supplier.** Record a supplier purchase against the order's items, then **confirm** it. Costs count toward profit only after confirmation.
4. **Ship and deliver.** Add one or more manual shipments and append status events. Separately, confirm order-level delivery.
5. **Expect a payout.** The order becomes eligible after the configured delay and is grouped into the expected payout batch.
6. **Receive the Etsy payout.** Record the actual payout and allocate it to expected batch items, including partial amounts, adjustments and missing payouts.
7. **Receive in Payoneer.** Record or import the deposit, then reconcile it against one or more Etsy payouts. Partial and unmatched balances are allowed.
8. **Withdraw to the bank.** Record the USD withdrawal and the actual PKR received, with fees kept separate.
9. **Handle exceptions.** Expenses, customer refunds (full or partial), supplier refunds and explicit corrections or reversals.
10. **Review results.** Dashboard and reports in both order-date and cash-date perspectives; export to CSV or Excel.

## 5. Business rules

Changing any of these needs owner approval and an update to this document and/or ARCHITECTURE.md.

1. V1 uses **manual** Etsy data entry. No Etsy API without explicit approval.
2. Store the Etsy Order ID only, never buyer or customer PII. Free-text fields (notes, import rows, URLs, audit payloads) must be filtered for PII **before** storage, because the database cannot enforce this.
3. One user owns one business in V1.
4. Suppliers are eBay, Amazon, AliExpress and custom.
5. **Product default costs are informational** and never affect actual profit or the ledger.
6. **Supplier costs affect actual profit only after the supplier purchase is confirmed.** Confirmation freezes the purchase's costs and items.
7. **The Etsy order amount is the Etsy net payable.** Never deduct Etsy fees again if that amount already reflects them. Gross customer value and individual Etsy fees are not required.
8. **Etsy payouts, Payoneer deposits and bank withdrawals are distinct financial events**, with Payoneer withdrawal and PKR bank receipt also kept distinct (System Architecture §6.2).
9. A Payoneer deposit may aggregate several Etsy payouts. **Partial and unmatched reconciliation must be supported.** Only deposits can be reconciled to payouts.
10. A Payoneer withdrawal can be any amount and does not need to map to orders.
11. **Estimated FX and actual realized USD/PKR conversion stay distinct.** Actual PKR received is authoritative for realized reporting.
12. Shipment tracking is manual in V1. An order can have several shipments. **Shipment delivery does not automatically make an order delivered or payout-eligible.** Order-level delivery confirmation is a separate action.
13. **Shared expense allocation is analytical only.** It never creates a second expense, and a shared expense is deducted exactly once at business level.
14. Refunds, supplier refunds, fees, corrections and reversals are represented explicitly (ARCHITECTURE.md §4).
15. Payout eligibility delay (default 14 days) and payout weekday (default Monday) are **configurable per business** and must not be hard-coded.
16. Payoneer fees are shared business expenses by default (PRD §3.5). A bank withdrawal is a transfer, not an expense; only its fee is.

## 6. Financial rules

### 6.1 Profit definitions (PRD §4, ERD §15)

| Measure | Definition |
| --- | --- |
| Direct (actual) order profit | Etsy net payable − confirmed supplier purchase costs − direct order expenses − refund adjustments |
| Business profit | Total direct order profit − shared business expenses |
| Business-adjusted order profit | Direct order profit − the order's analytical allocation of shared expenses |

- The default allocation is **proportional** to each order's Etsy net payable in the reporting period. Equal, manual and custom methods are also supported.
- Each method and period combination is an **alternative scenario**. Reports select one scenario and never sum alternatives.
- Reports distinguish expected, realized and cash profit, as well as direct and business-adjusted profit.
- **Order-date perspective:** revenue and relevant costs are dated to the order date. **Cash-date perspective:** actual receipts and payments are dated to when they occurred.

### 6.2 Financial integrity (PRD §4)

- Finalized financial transactions are immutable. Corrections use adjustment entries or exact reversals.
- Every financial record has an audit trail.
- All amounts use exact decimals, and every amount has an explicit currency.
- **USD and PKR are never added together without an explicit conversion.**
- Each real-world financial event is posted exactly once. Duplicate manual entry of the same fee or purchase must be prevented by provenance and duplicate review, because the ledger cannot detect it.

### 6.3 Clarified financial semantics (recorded 2026-11-24)

- **Refunds** post their recorded amount, never the original order or purchase total. A refund may be represented as contra-revenue or as an expense, and reports must count it **once** in either form.
- **No cumulative refund cap against Etsy net payable is enforced**, because net payable does not establish gross refund or fee-compensation limits. See open decision D6.
- **Fees stay separate from principal.** An embedded Payoneer fee and a standalone fee transaction are different events, and one fee is never posted twice or re-entered as a manual expense. When a statement reports net amounts, the import must declare that convention instead of subtracting the fee again.
- **Withdrawal:** the USD principal belongs to the Payoneer withdrawal and the PKR receipt to the bank withdrawal. **No `usd × rate = pkr` equality is imposed.** FX gains or losses are recorded only as explicit adjustment events.
- **Signed adjustments are valid.** Negative Payoneer ADJUSTMENT/OTHER transactions are legitimate (confirmed defect fix, migration 0008).
- **Opening balances, refund adjustments, Payoneer ADJUSTMENT/OTHER and generic corrections** require explicit declared posting instructions. No accounting direction is ever inferred from descriptions, signs or "OTHER".
- **A reversed journal cannot also receive a generic adjustment.** Corrections after a reversal are new events.

## 7. Acceptance criteria

- **V1 success (PRD §10):** a seller can manually manage the complete lifecycle of an Etsy order, from creation through supplier purchase, delivery, Etsy payout, Payoneer receipt and bank withdrawal to final profitability reporting.
- Every journey in §4 keeps the ledger balanced per currency, posts each event once (idempotent retries) and rolls back fully on failure.
- No user can read or change another tenant's data. This is verified by cross-tenant tests for every data path.
- Expected and actual figures, and estimated and actual FX, are never conflated in any report.
- The architecture testing strategy's scenarios (System Architecture §12) have automated tests: tenant isolation, duplicate imports, 14-day eligibility, payout-day batching, partial payouts, multiple payouts per deposit, partial refunds, USD/PKR conversion, shared allocation, ledger balancing, idempotent jobs.
- The application runs with **zero mandatory cost** (PRD §7) and fails safely when a free quota is exhausted.

## 8. Product decision log

| Date | Decision | Source |
| --- | --- | --- |
| 2026-11-23 | PRD v1.2 defines the complete V1 scope; delivery is phased but the scope is not reduced | PRD §10 |
| 2026-11-24 | Exchange rates and background jobs are **tenant-owned**; there are no global rows. This supersedes the earlier ERD's global rates and system jobs | Owner requirement during the schema audit; ERD v1.2 §13–14 |
| 2026-11-24 | Declared posting instructions are required for refund adjustments, Payoneer ADJUSTMENT/OTHER, opening balances and generic adjustments | Owner-approved during financial hardening |
| 2026-11-24 | Manual shipments with append-only event history; several shipments per order; shipment delivery is independent of order delivery and payout eligibility | ERD v1.2 §18 |
| 2026-11-24 | Adjustments against an already reversed journal are rejected | Owner-requested integrity follow-up (migration 0007) |
| 2026-11-24 | Negative non-deposit Payoneer transactions must not hit the reconciliation cap | Reproduced defect, fixed in migration 0008 |
| 2026-11-25 | The repository is public; the owner accepted publishing these documents | Owner |
| 2026-11-25 | **D1 resolved:** email and password with Better Auth's default secure hashing (work factor unchanged) stay. Authentication runs on separate free Node compute behind the Worker proxy; the provider is chosen and validated at deployment. PRD §3.1 is unchanged | Owner (ARCHITECTURE.md A19) |
| 2026-11-25 | Sign-up is enumeration-resistant (generic response, no auto sign-in). **Accepted limitation:** an email can still be tested through the sign-in flow until email verification exists (D2) | Owner (ARCHITECTURE.md A20) |
| 2026-11-25 | Onboarding creates the starter chart **without** a REFUND account until D5 is decided; payout settings default to 14 days and Monday | Owner (ARCHITECTURE.md A22) |

## 9. Open product decisions

| # | Decision needed | Why it matters |
| --- | --- | --- |
| D1 | ~~Sign-in method if secure password hashing cannot run on Workers Free~~ | **Resolved 2026-11-25** (decision log above) |
| D2 | A free email provider for password reset and verification | PRD §3.1 makes reset conditional on free email. Also needed to close the remaining account-enumeration gap (ARCHITECTURE.md §7.2) |
| D3 | **Currency rounding rules** and the precision used for conversion and reporting | Still undefined (ERD §17 item 3); needed before any FX calculation |
| D4 | Whether bank fees are deducted before or after conversion in realized-FX reporting | Changes realized-rate figures |
| D5 | Which REFUND representation (contra-revenue or expense) new businesses use by default | Starter chart of accounts at onboarding |
| D6 | Whether any refund cap or validation against order value is wanted | Currently none is enforced (§6.3) |
