import 'server-only';

// Order status transitions approved for Phase 2a (ARCHITECTURE.md A26):
//   NEW -> SUPPLIER_ORDERED -> SHIPPED -> IN_TRANSIT -> DELIVERED
// CANCELLED is allowed from any status before DELIVERED. DELIVERED requires a
// delivery date. Payout and refund statuses (PAYOUT_ELIGIBLE, PAYOUT_SCHEDULED,
// PARTIALLY_PAID, PAID, REFUNDED, PARTIALLY_REFUNDED) exist in the schema but
// cannot be set until their phases. Order status is independent of shipment
// records and of the ledger.

export const ORDER_STATUSES = [
  'NEW', 'SUPPLIER_ORDERED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED',
  'PAYOUT_ELIGIBLE', 'PAYOUT_SCHEDULED', 'PARTIALLY_PAID', 'PAID',
  'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses a user may request in Phase 2a. */
export const SETTABLE_ORDER_STATUSES = ['SUPPLIER_ORDERED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'] as const;
export type SettableOrderStatus = (typeof SETTABLE_ORDER_STATUSES)[number];

const NEXT: Readonly<Record<OrderStatus, readonly SettableOrderStatus[]>> = {
  NEW: ['SUPPLIER_ORDERED', 'CANCELLED'],
  SUPPLIER_ORDERED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
  // Later phases own these; nothing can be requested from them yet.
  PAYOUT_ELIGIBLE: [],
  PAYOUT_SCHEDULED: [],
  PARTIALLY_PAID: [],
  PAID: [],
  REFUNDED: [],
  PARTIALLY_REFUNDED: [],
};

export function allowedNextStatuses(from: OrderStatus): readonly SettableOrderStatus[] {
  return NEXT[from];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (NEXT[from] as readonly OrderStatus[]).includes(to);
}

/** Order header and items can be edited until the order is cancelled. */
export function isOrderEditable(status: OrderStatus): boolean {
  return status !== 'CANCELLED';
}
