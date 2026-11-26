import { describe, expect, it } from 'vitest';
import { toOrderView } from '@/server/orders/service';
import { toPurchaseView } from '@/server/purchases/service';
import type { OrderRow } from '@/server/dal/orders';
import type { PurchaseListRow } from '@/server/dal/supplier-purchases';

const ID = '3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f';

function purchaseRow(overrides: Partial<PurchaseListRow>): PurchaseListRow {
  return {
    id: ID, accountId: ID, supplierId: ID, supplierOrderReference: null, purchaseUrl: null, purchaseDate: null, totalAmount: '25.2500',
    currency: 'USD', status: 'DRAFT', confirmedAt: null, createdAt: new Date('2026-11-26T00:00:00Z'), updatedAt: new Date('2026-11-26T00:00:00Z'),
    notes: null, supplierName: 'Supplier', reversed: false, ...overrides,
  };
}

function orderRow(overrides: Partial<OrderRow>): OrderRow {
  return {
    id: ID, accountId: ID, etsyOrderId: '1', orderDate: new Date('2026-11-24T19:00:00Z'), netPayableAmount: '100.0000', currency: 'USD',
    status: 'NEW', deliveredAt: null, notes: null, createdAt: new Date('2026-11-26T00:00:00Z'), updatedAt: new Date('2026-11-26T00:00:00Z'), ...overrides,
  };
}

describe('purchase view', () => {
  it('shows the confirmation date in the business timezone, not in UTC', () => {
    // 20:00 UTC on the 26th is already the 27th in Karachi (UTC+5) but still the 26th in New York.
    const confirmedAt = new Date('2026-11-26T20:00:00Z');
    const view = toPurchaseView(purchaseRow({ status: 'CONFIRMED', confirmedAt, purchaseDate: new Date('2026-11-25T19:00:00Z') }), 'Asia/Karachi');
    expect(view.confirmedDate).toBe('2026-11-27');
    expect(view.purchaseDate).toBe('2026-11-26');
    expect(toPurchaseView(purchaseRow({ status: 'CONFIRMED', confirmedAt, purchaseDate: confirmedAt }), 'America/New_York').confirmedDate).toBe('2026-11-26');
    expect(view.confirmedAt).toBe('2026-11-26T20:00:00.000Z');
  });

  it('has no confirmation date for a draft', () => {
    expect(toPurchaseView(purchaseRow({}), 'Asia/Karachi')).toMatchObject({ confirmedAt: null, confirmedDate: null, purchaseDate: null });
  });

  it('shows a reversed purchase as REVERSED while keeping its stored status', () => {
    const view = toPurchaseView(purchaseRow({ status: 'CONFIRMED', reversed: true, confirmedAt: new Date() }), 'UTC');
    expect([view.status, view.effectiveStatus]).toEqual(['CONFIRMED', 'REVERSED']);
    expect(toPurchaseView(purchaseRow({ status: 'CANCELLED' }), 'UTC').effectiveStatus).toBe('CANCELLED');
  });

  it('formats the total without rounding and keeps four decimals only when present', () => {
    expect(toPurchaseView(purchaseRow({ totalAmount: '25.2500' }), 'UTC').totalAmount).toBe('25.25');
    expect(toPurchaseView(purchaseRow({ totalAmount: '0.0050' }), 'UTC').totalAmount).toBe('0.0050');
  });
});

describe('order view', () => {
  it('shows the order and delivery dates in the business timezone', () => {
    const view = toOrderView(orderRow({ status: 'DELIVERED', deliveredAt: new Date('2026-11-27T19:00:00Z') }), 'Asia/Karachi');
    expect(view).toMatchObject({ orderDate: '2026-11-25', deliveredDate: '2026-11-28', netPayableAmount: '100.00', status: 'DELIVERED' });
    expect(toOrderView(orderRow({}), 'Asia/Karachi').deliveredDate).toBeNull();
  });
});
