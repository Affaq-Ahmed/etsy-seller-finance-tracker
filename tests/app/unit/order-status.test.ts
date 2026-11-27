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

describe('order profit (direct profit before refunds)', () => {
  it('is net payable minus confirmed costs, and labels what it leaves out', () => {
    expect(buildOrderProfit('100.0000', { confirmedCost: '25.2500', draftCost: '8.0000' }, undefined, 'SUPPLIER_ORDERED')).toEqual({
      netPayable: '100.00', revenue: '100.00', revenueExcluded: false, confirmedSupplierCosts: '25.25',
      directProfitBeforeRefunds: '74.75', draftSupplierCosts: '8.00', confirmedDirectExpenses: '0.00', draftDirectExpenses: '0.00', includesExpenses: true, includesRefunds: false,
    });
  });

  it('treats a missing summary as no costs', () => {
    expect(buildOrderProfit('87.5000', undefined, undefined, 'NEW')).toMatchObject({ confirmedSupplierCosts: '0.00', directProfitBeforeRefunds: '87.50' });
  });

  it('never counts draft costs', () => {
    expect(buildOrderProfit('10.0000', { confirmedCost: '0', draftCost: '999.0000' }, undefined, 'NEW').directProfitBeforeRefunds).toBe('10.00');
  });

  it('is exact for fractional cents and shows losses', () => {
    expect(buildOrderProfit('0.3000', { confirmedCost: '0.2000', draftCost: '0' }, undefined, 'NEW').directProfitBeforeRefunds).toBe('0.10');
    expect(buildOrderProfit('10.0000', { confirmedCost: '14.7500', draftCost: '0' }, undefined, 'NEW').directProfitBeforeRefunds).toBe('-4.75');
    expect(buildOrderProfit('0.0000', { confirmedCost: '0.0050', draftCost: '0' }, undefined, 'NEW').directProfitBeforeRefunds).toBe('-0.0050');
  });

  describe('order expenses (ARCHITECTURE.md A38)', () => {
    const costs = { confirmedCost: '25.2500', draftCost: '8.0000' };

    it('subtracts confirmed expenses after supplier costs and shows draft expenses apart', () => {
      expect(buildOrderProfit('100.0000', costs, { confirmedExpenses: '4.2500', draftExpenses: '7.0000' }, 'SUPPLIER_ORDERED')).toEqual({
        netPayable: '100.00', revenue: '100.00', revenueExcluded: false, confirmedSupplierCosts: '25.25', draftSupplierCosts: '8.00',
        confirmedDirectExpenses: '4.25', draftDirectExpenses: '7.00', directProfitBeforeRefunds: '70.50', includesExpenses: true, includesRefunds: false,
      });
    });

    it('never counts draft expenses, and treats a missing summary as none', () => {
      expect(buildOrderProfit('10.0000', undefined, { confirmedExpenses: '0', draftExpenses: '999.0000' }, 'NEW').directProfitBeforeRefunds).toBe('10.00');
      expect(buildOrderProfit('10.0000', undefined, undefined, 'NEW')).toMatchObject({ confirmedDirectExpenses: '0.00', draftDirectExpenses: '0.00' });
    });

    it('is exact with fractional cents: 0.10 + 0.20 on a 0.30 order is exactly 0', () => {
      expect(buildOrderProfit('0.3000', undefined, { confirmedExpenses: '0.3000', draftExpenses: '0' }, 'NEW').directProfitBeforeRefunds).toBe('0.00');
      expect(buildOrderProfit('0.3000', { confirmedCost: '0.1000', draftCost: '0' }, { confirmedExpenses: '0.2100', draftExpenses: '0' }, 'NEW').directProfitBeforeRefunds).toBe('-0.01');
      expect(buildOrderProfit('0.0000', undefined, { confirmedExpenses: '0.0050', draftExpenses: '0' }, 'NEW').directProfitBeforeRefunds).toBe('-0.0050');
    });

    it('still counts expenses on a cancelled order, whose revenue is zero, so it shows the loss', () => {
      expect(buildOrderProfit('100.0000', undefined, { confirmedExpenses: '4.2500', draftExpenses: '1.0000' }, 'CANCELLED')).toMatchObject({
        revenue: '0.00', revenueExcluded: true, confirmedDirectExpenses: '4.25', draftDirectExpenses: '1.00', directProfitBeforeRefunds: '-4.25',
      });
      expect(buildOrderProfit('100.0000', costs, { confirmedExpenses: '4.2500', draftExpenses: '0' }, 'CANCELLED').directProfitBeforeRefunds).toBe('-29.50');
    });
  });

  describe('cancelled orders count no revenue (PRODUCT.md D9)', () => {
    it('shows the recorded net payable but counts zero of it', () => {
      expect(buildOrderProfit('100.0000', undefined, undefined, 'CANCELLED')).toEqual({
        netPayable: '100.00', revenue: '0.00', revenueExcluded: true, confirmedSupplierCosts: '0.00',
        directProfitBeforeRefunds: '0.00', draftSupplierCosts: '0.00', confirmedDirectExpenses: '0.00', draftDirectExpenses: '0.00', includesExpenses: true, includesRefunds: false,
      });
    });

    it('keeps confirmed costs, so the order shows a loss, exactly', () => {
      expect(buildOrderProfit('100.0000', { confirmedCost: '25.2500', draftCost: '0' }, undefined, 'CANCELLED').directProfitBeforeRefunds).toBe('-25.25');
      expect(buildOrderProfit('0.3000', { confirmedCost: '0.2000', draftCost: '0' }, undefined, 'CANCELLED').directProfitBeforeRefunds).toBe('-0.20');
    });

    it('still never counts draft costs', () => {
      expect(buildOrderProfit('50.0000', { confirmedCost: '0', draftCost: '12.0000' }, undefined, 'CANCELLED')).toMatchObject({ directProfitBeforeRefunds: '0.00', draftSupplierCosts: '12.00' });
    });

    it('excludes revenue for CANCELLED only, never for any other status', () => {
      for (const status of ORDER_STATUSES) {
        const profit = buildOrderProfit('10.0000', { confirmedCost: '4.0000', draftCost: '0' }, undefined, status);
        expect(profit.revenueExcluded, status).toBe(status === 'CANCELLED');
        expect(profit.directProfitBeforeRefunds, status).toBe(status === 'CANCELLED' ? '-4.00' : '6.00');
      }
    });
  });
});
