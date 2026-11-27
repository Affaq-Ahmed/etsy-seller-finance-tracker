# Product

**Last updated:** 2026-11-26
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
2. **Record an order.** Enter the Etsy Order ID, net payable amount, currency, items and quantities, and optionally link products. *Implemented in Phase 2a (2026-11-26).*
3. **Buy from a supplier.** Record a supplier purchase against the order's items, then **confirm** it. Costs count toward profit only after confirmation. *Implemented in Phase 2a; a confirmed purchase is corrected by reversing it and recording a new one.*
4. **Ship and deliver.** Add one or more manual shipments and append status events. Separately, confirm order-level delivery.
5. **Expect a payout.** The order becomes eligible after the configured delay and is grouped into the expected payout batch.
6. **Receive the Etsy payout.** Record the actual payout and allocate it to expected batch items, including partial amounts, adjustments and missing payouts.
7. **Receive in Payoneer.** Record or import the deposit, then reconcile it against one or more Etsy payouts. Partial and unmatched balances are allowed.
8. **Withdraw to the bank.** Record the USD withdrawal and the actual PKR received, with fees kept separate.
9. **Handle exceptions.** Expenses, customer refunds (full or partial), supplier refunds and explicit corrections or reversals. *Expenses (draft, confirm, void, reverse; order-level and shared) are implemented in Phase 2b, Slice 1 (2026-11-26); refunds are not.*
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
- **Supplier purchase confirmation (Phase 2a).** Confirming debits `SUPPLIER_COST` and credits **Supplier Payable**, a liability account, for the exact purchase total, dated at the purchase date. The cost is recognized once and the obligation to pay stays open. Paying the supplier is a separate event (Phase 3, D7) and must never post the cost again. `PAYONEER` is deliberately **not** credited at confirmation, so a later Payoneer statement import cannot double-count the payment.
- **Actual order profit shown in Phase 2a (superseded by Phase 2b Slice 1 below; kept for the record)** was "direct profit before expenses and refunds": Etsy net payable minus confirmed, unreversed supplier costs on the order's items. Draft, cancelled and reversed purchases never count. The label and response flags state that order expenses and refunds are not included yet (Phase 2b).
- **Cancelled orders (D9, resolved).** A CANCELLED order contributes **zero** Etsy revenue to profit, because Etsy will not pay for it; the recorded net payable is still shown, marked "not counted". Supplier costs already **confirmed** stay recorded and keep counting, so a cancelled order with confirmed costs shows a loss. **Nothing is reversed automatically**: the owner reverses a purchase explicitly if the supplier cost is recovered. New supplier purchases cannot be created for, or edited to include, a cancelled order's items. A draft purchase that already covers a cancelled order cannot be confirmed (the owner removes those lines or cancels the draft). Confirming such a draft again after it was confirmed earlier stays a harmless no-op.
- **Corrections to a confirmed purchase** use the existing exact, idempotent journal reversal with a required reason. A reversed purchase keeps its stored status (confirmed rows are immutable) and is shown as REVERSED, derived from the ledger. A corrected purchase is entered as a new one with a blank or different supplier reference and notes which purchase it replaces. Supplier-reference uniqueness is not relaxed.
- **Expenses (Phase 2b, Slice 1, 2026-11-26).**
  - **States.** An expense is a DRAFT (counts nowhere, posts nothing), then CONFIRMED (posts once) or VOIDED (a draft discarded, posts nothing). A DIRECT expense belongs to one order; a SHARED expense belongs to the business and has no order. There is no draft editing: a wrong draft is voided and entered again.
  - **Posting.** Confirming debits the `DIRECT_EXPENSE` or `SHARED_EXPENSE` account and credits **Expenses Payable**, a liability account (existing `UNCLASSIFIED` role, found by exact name, type and currency, created once and audited inside the first confirmation), for the exact amount, dated at the expense date. The expense is recognized once and the obligation to pay stays open. Paying it is a separate Phase 3 event (D14) and must never post the expense again. `PAYONEER`, Supplier Payable and any other asset are never credited, so a later Payoneer import cannot double-count it.
  - **Corrections.** A confirmed expense is immutable. It is corrected by an exact reversal with a required reason (shown as REVERSED, derived from the ledger), followed by a new expense if needed.
  - **Categories.** Only the six fixed types of PRD §3.7 exist (advertising, marketplace subscription, software subscription, shipping, refund-related, miscellaneous). **Payoneer fees are not a manual expense category**: they arrive from Payoneer transactions (Phase 3) and are never entered by hand, so a manual entry cannot double-count them. Custom categories are deferred.
  - **Profit.** Order profit becomes **direct profit before refunds** = Etsy net payable (zero for a cancelled order) − confirmed, unreversed supplier costs − confirmed, unreversed DIRECT expenses. Draft expenses are shown separately and never counted. **SHARED expenses are never included in order profit** (business profit and allocation are a later slice; allocation stays analytical, never a second expense). Refunds are still not included.
  - **Cancelled orders.** Unlike supplier purchases (D9), DIRECT expenses on a cancelled order stay valid: they can be recorded or confirmed after the cancellation (for example return postage caused by the cancellation) and they count toward profit. Nothing is reversed automatically.
  - **Not duplicated elsewhere.** Etsy fees are already in net payable (§5 rule 7), supplier costs belong in supplier purchases, and a customer refund is a refund, not a "refund-related" expense (that category means costs caused by a refund).
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
| 2026-11-26 | **Phase 2a** (orders, products, suppliers, supplier purchases, profit before expenses and refunds) is split from Phase 2b (expenses and refunds, refunds after D5). Order items keep name, SKU and quantity snapshots only: the Etsy net payable stays at order level and items carry no price (PRD §3.2) | Owner (ARCHITECTURE.md A32) |
| 2026-11-26 | Orders are **not** posted to the ledger in Phase 2a; they stay editable and profit is computed from records. Posting timing is decided with Phase 3 payouts (D8) | Owner (ARCHITECTURE.md A27) |
| 2026-11-26 | Order status changes in Phase 2a: NEW → SUPPLIER_ORDERED → SHIPPED → IN_TRANSIT → DELIVERED, one step at a time, CANCELLED before DELIVERED, DELIVERED needs a delivery date, and confirming the first purchase moves NEW to SUPPLIER_ORDERED. Payout and refund statuses cannot be set yet | Owner (ARCHITECTURE.md A26) |
| 2026-11-26 | Supplier cost is credited to a **Supplier Payable** liability account (existing UNCLASSIFIED role, no new role) | Owner (ARCHITECTURE.md A25) |
| 2026-11-26 | A confirmed purchase is corrected by a reversal with a required reason; a replacement notes what it replaces | Owner (ARCHITECTURE.md A28) |
| 2026-11-26 | Phase 2a records money only in the business currency (USD by default); a mismatched currency is rejected with a clear error. No FX | Owner (ARCHITECTURE.md A32) |
| 2026-11-26 | Calendar dates are interpreted and displayed in the business timezone (Asia/Karachi by default) | Owner (ARCHITECTURE.md A29) |
| 2026-11-26 | **D3 stays open** with a no-rounding interim: amounts have at most 2 decimals, a line total is exactly quantity × unit cost, uneven totals are split into lines, and the user allocates shipping, tax and discounts across lines | Owner (ARCHITECTURE.md A30) |
| 2026-11-26 | Free-text fields are screened for email and phone patterns before storage; purchase and image URLs must be http(s), at most 2048 characters, with no credentials or email. **Postal addresses and names cannot be detected reliably** | Owner (ARCHITECTURE.md A31) |
| 2026-11-26 | **D5 resolved (option A):** refunds are **contra-revenue**. The REFUND account is an INCOME account named *Etsy Refunds* in the business base currency. New businesses get it with the refund slice; an existing business gets it lazily at its first refund, inside the same transaction. No migration | Owner (ARCHITECTURE.md A34) |
| 2026-11-26 | **D9 resolved:** a cancelled order counts zero Etsy revenue; confirmed supplier costs stay and keep affecting profit; new purchases on cancelled orders are rejected at the API and the data layer; nothing is reversed automatically | Owner (ARCHITECTURE.md A35) |
| 2026-11-26 | **D10 resolved (Phase 2b, Slice 1: expenses).** Confirming an expense credits a new **Expenses Payable** liability (UNCLASSIFIED role, found by exact name, type and currency; Phase 3 settles it, see D14). **Manual Payoneer-fee expenses are blocked** (Payoneer fees come from Payoneer transactions only). DIRECT expenses on a cancelled order stay valid and count toward profit. Confirmed expenses are immutable and corrected by a reversal with a required reason. Shared expense allocation stays out of scope | Owner (ARCHITECTURE.md A36, A37, A38) |
| 2026-11-26 | **Defaults applied in Slice 1, pending owner objection:** custom expense categories are deferred (six fixed types only); Expenses Payable is created lazily at the first confirmation and is not added to the starter chart; no draft editing (void and re-enter); an expense amount must be above zero; business currency only | Planner defaults, adopted by the orchestrator (ARCHITECTURE.md A36, A37) |

## 9. Open product decisions

| # | Decision needed | Why it matters |
| --- | --- | --- |
| D1 | ~~Sign-in method if secure password hashing cannot run on Workers Free~~ | **Resolved 2026-11-25** (decision log above) |
| D2 | A free email provider for password reset and verification | PRD §3.1 makes reset conditional on free email. Also needed to close the remaining account-enumeration gap (ARCHITECTURE.md §7.2) |
| D3 | **Currency rounding rules** and the precision used for conversion and reporting | Still undefined (ERD §17 item 3); needed before any FX calculation |
| D4 | Whether bank fees are deducted before or after conversion in realized-FX reporting | Changes realized-rate figures |
| D5 | ~~Which REFUND representation (contra-revenue or expense) new businesses use by default~~ | **Resolved 2026-11-26, option A: contra-revenue INCOME** (decision log above; ARCHITECTURE.md A34) |
| D6 | Whether any refund cap or validation against order value is wanted | Currently none is enforced (§6.3) |
| D7 | **How a supplier payment settles Supplier Payable** (Phase 3). Proposed: a Payoneer or bank payment is recorded with explicit posting legs, debit Supplier Payable and credit the paying asset, and never touches `SUPPLIER_COST` | Prevents double-counting supplier costs against Payoneer imports. See ARCHITECTURE.md A25 |
| D8 | **When an order's INITIAL journal (debit ETSY_RECEIVABLE, credit REVENUE) is posted.** Posting freezes the order's amount, date and Etsy ID | Decide with Phase 3 payouts. Historical orders must then be posted idempotently |
| D9 | ~~What a CANCELLED order contributes to profit, and whether the API refuses purchases on cancelled orders~~ | **Resolved 2026-11-26** (decision log above; ARCHITECTURE.md A35) |
| D10 | ~~Expenses (Phase 2b): which account a confirmed expense credits, and whether manual Payoneer-fee expenses are blocked~~ | **Resolved 2026-11-26** (decision log above; ARCHITECTURE.md A36, A37) |
| D11 | **Customer refunds (Phase 2b): the credit side and the meaning of FULL / PARTIAL / OTHER.** What does a recorded refund reduce (for example the Etsy receivable, or a refunds-owed liability)? With no cap (D6) and no gross order value, what does FULL mean, and should recording a refund set the order status to REFUNDED or PARTIALLY_REFUNDED (those statuses cannot be set today)? | Depends on D5, D6 and D8 |
| D12 | **Refund adjustments and non-refundable fees (PRD §3.8).** Which adjustment types exist and how each is posted (they need explicit posting legs), and how "refund adjustments" in the profit formula relates to the refund amounts themselves | Proposed to leave out of the first Phase 2b slice |
| D13 | **Supplier refunds (Phase 2b).** (a) The standard posting allows only an ASSET on the debit side, so it cannot reduce the Supplier Payable liability: which asset is debited (for example a new *Supplier Refunds Receivable*, settled in Phase 3)? (b) A purchase covering several orders needs a refund attributed to orders without rounding (D3): allow supplier refunds only on single-order purchases, or add per-line refund allocation (a new migration)? (c) Purchase statuses can only move forward in the database, so reversing a refund would leave PARTIALLY_REFUNDED or REFUNDED stale: leave the status untouched and derive the refunded amount, or accept a stale status? (d) May the refunds on a purchase total more than the purchase? | Parts of this decide whether migration 0010 is needed |
| D14 | **How a payment settles Expenses Payable** (Phase 3), alongside D7. Proposed: a Payoneer or bank payment is recorded with explicit posting legs, debit Expenses Payable and credit the paying asset, and never touches an expense account again. Includes Etsy-deducted costs such as Etsy Ads: a payout shortfall must settle Expenses Payable, never post the expense a second time | Prevents double-counting expenses against Phase 3 payout and Payoneer imports. See ARCHITECTURE.md A36 |

**Where D3 (rounding) will matter** once it is decided: splitting purchase-level shipping, tax or discounts across lines; a supplier total that does not divide evenly by quantity; FX conversion; display precision (stored with 4 decimals, shown with 2 unless more are present); and any report that divides (averages, per-unit cost, allocation of shared expenses). Phase 2a avoids all of these by never dividing or converting.
