# Manual shipment tracking

An order has zero or more shipments, and each shipment has an append-only event history. Direct restrictive tenant FKs and composite order/shipment FKs reject cross-tenant relationships. Order deletion cannot erase shipments; shipment deletion and event UPDATE/DELETE are rejected. Events carry no customer identity/address fields. Free-text notes/location/URLs still require PII filtering during ingestion.

Create a shipment as PENDING. Creation automatically appends its initial PENDING event. Append events with event_type, event_date and optional description/location. A database trigger validates the transition and updates shipment_status, shipped_at and delivered_at atomically; direct status/timestamp mutation is rejected. Carrier, tracking reference/URL, estimated delivery and notes remain manually editable. Metadata edits add a NOTE event and structured metadata audit entry; both before_data and after_data include notes, including explicit null values when notes are added or cleared. Notes and their audit copies require the same ingestion PII filtering. Caller identity attribution remains a service responsibility.

Allowed transitions:

| Current | Next |
| --- | --- |
| PENDING | SHIPPED, CANCELLED |
| SHIPPED | IN_TRANSIT, DELIVERED, EXCEPTION, RETURNED, CANCELLED |
| IN_TRANSIT | IN_TRANSIT, DELIVERED, EXCEPTION, RETURNED |
| EXCEPTION | IN_TRANSIT, DELIVERED, RETURNED, CANCELLED, EXCEPTION |
| DELIVERED | RETURNED |
| RETURNED / CANCELLED | Terminal; NOTE events still allowed |

These operational transitions support return/cancel/exception workflows without changing financial records. Corrections to terminal statuses require a new shipment plus an explanatory NOTE; historical events are not rewritten. Status event dates must not precede shipment.created_at or the last actual status event. Events exactly at created_at are valid. Historical NOTE events may predate shipment creation and never change shipment state. Historical observations can be appended as NOTE events without changing state. Equal status timestamps are ordered using the generated event_sequence. Metadata updates leave delivered/shipped facts unchanged. A delivered_at timestamp cannot precede shipped_at.

Shipment status is independent of order.status and orders.delivered_at. Delivery of one package must not automatically make a multi-package order payout-eligible. Order-level delivery confirmation and the existing configurable eligibility schedule remain the responsibility of their existing workflow. No tracking API, frontend, or background tracking service is added.

Indexes cover tenant/order, carrier/tracking reference, status/estimated delivery, and event sequence/date history. This is manual operational persistence. Database privileges must prevent trigger disabling, TRUNCATE and arbitrary trigger creation; authorization/RLS remains separate from referential integrity.

Forward migration 0007_integrity_followup.sql replaces the status-event and metadata-audit functions while preserving migrations 0000–0006. The maintained shipment SQL is the cumulative 0006 source plus shipment-followup.sql.
