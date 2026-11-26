import { describe, expect, it } from 'vitest';
import {
  allowedNextStatuses, canTransition, isOrderEditable, ORDER_STATUSES, SETTABLE_ORDER_STATUSES, type OrderStatus,
} from '@/server/orders/status';
import { buildOrderProfit } from '@/server/orders/profit';

describe('order status transitions (owner-approved, Phase 2a)', () => {
  const expected: Record<string, string[]> = {
    NEW: ['SUPPLIER_ORDERED', 'CANCELLED'],
    SUPPLIER_ORDERED: ['SHIPPED', 'CANCELLED'],
    SHIPPED: ['IN_TRANSIT', 'CANCELLED'],
    IN_TRANSIT: ['DELIVERED', 'CANCELLED'],
  };

  it('allows exactly the approved next steps', () => {
    for (const [from, next] of Object.entries(expected)) expect([...allowedNextStatuses(from as OrderStatus)]).toEqual(next);
  });

  it('allows no transition from any other status', () => {
    for (const status of ORDER_STATUSES.filter((s) => !(s in expected))) expect(allowedNextStatuses(status), status).toEqual([]);
  });

  it('checks every ordered pair: only the approved ones are allowed', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe((expected[from] ?? []).includes(to));
      }
    }
  });

  it('can never be set to a payout or refund status, or back to NEW', () => {
    const settable: readonly string[] = SETTABLE_ORDER_STATUSES;
    for (const status of ['NEW', 'PAYOUT_ELIGIBLE', 'PAYOUT_SCHEDULED', 'PARTIALLY_PAID', 'PAID', 'REFUNDED', 'PARTIALLY_REFUNDED']) {
      expect(settable).not.toContain(status);
    }
  });

  it('keeps every schema status known, so nothing is silently unhandled', () => {
    expect(ORDER_STATUSES).toHaveLength(12);
  });

  it('allows editing until an order is cancelled', () => {
    expect(isOrderEditable('NEW')).toBe(true);
    expect(isOrderEditable('DELIVERED')).toBe(true);
    expect(isOrderEditable('CANCELLED')).toBe(false);
  });
});

describe('order profit (direct profit before expenses and refunds)', () => {
  it('is net payable minus confirmed costs, and labels what it leaves out', () => {
    expect(buildOrderProfit('100.0000', { confirmedCost: '25.2500', draftCost: '8.0000' }, 'SUPPLIER_ORDERED')).toEqual({
      netPayable: '100.00', revenue: '100.00', revenueExcluded: false, confirmedSupplierCosts: '25.25',
      directProfitBeforeExpensesAndRefunds: '74.75', draftSupplierCosts: '8.00', includesExpenses: false, includesRefunds: false,
    });
  });

  it('treats a missing summary as no costs', () => {
    expect(buildOrderProfit('87.5000', undefined, 'NEW')).toMatchObject({ confirmedSupplierCosts: '0.00', directProfitBeforeExpensesAndRefunds: '87.50' });
  });

  it('never counts draft costs', () => {
    expect(buildOrderProfit('10.0000', { confirmedCost: '0', draftCost: '999.0000' }, 'NEW').directProfitBeforeExpensesAndRefunds).toBe('10.00');
  });

  it('is exact for fractional cents and shows losses', () => {
    expect(buildOrderProfit('0.3000', { confirmedCost: '0.2000', draftCost: '0' }, 'NEW').directProfitBeforeExpensesAndRefunds).toBe('0.10');
    expect(buildOrderProfit('10.0000', { confirmedCost: '14.7500', draftCost: '0' }, 'NEW').directProfitBeforeExpensesAndRefunds).toBe('-4.75');
    expect(buildOrderProfit('0.0000', { confirmedCost: '0.0050', draftCost: '0' }, 'NEW').directProfitBeforeExpensesAndRefunds).toBe('-0.0050');
  });

  describe('cancelled orders count no revenue (PRODUCT.md D9)', () => {
    it('shows the recorded net payable but counts zero of it', () => {
      expect(buildOrderProfit('100.0000', undefined, 'CANCELLED')).toEqual({
        netPayable: '100.00', revenue: '0.00', revenueExcluded: true, confirmedSupplierCosts: '0.00',
        directProfitBeforeExpensesAndRefunds: '0.00', draftSupplierCosts: '0.00', includesExpenses: false, includesRefunds: false,
      });
    });

    it('keeps confirmed costs, so the order shows a loss, exactly', () => {
      expect(buildOrderProfit('100.0000', { confirmedCost: '25.2500', draftCost: '0' }, 'CANCELLED').directProfitBeforeExpensesAndRefunds).toBe('-25.25');
      expect(buildOrderProfit('0.3000', { confirmedCost: '0.2000', draftCost: '0' }, 'CANCELLED').directProfitBeforeExpensesAndRefunds).toBe('-0.20');
    });

    it('still never counts draft costs', () => {
      expect(buildOrderProfit('50.0000', { confirmedCost: '0', draftCost: '12.0000' }, 'CANCELLED')).toMatchObject({ directProfitBeforeExpensesAndRefunds: '0.00', draftSupplierCosts: '12.00' });
    });

    it('excludes revenue for CANCELLED only, never for any other status', () => {
      for (const status of ORDER_STATUSES) {
        const profit = buildOrderProfit('10.0000', { confirmedCost: '4.0000', draftCost: '0' }, status);
        expect(profit.revenueExcluded, status).toBe(status === 'CANCELLED');
        expect(profit.directProfitBeforeExpensesAndRefunds, status).toBe(status === 'CANCELLED' ? '-4.00' : '6.00');
      }
    });
  });
});
