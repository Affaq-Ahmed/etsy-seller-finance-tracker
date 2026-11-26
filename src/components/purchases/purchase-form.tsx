'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { callApi, describeFailure } from '@/lib/api-client';
import { formatMoney, isWithinMoneyLimit, multiplyByQuantity, parseMoneyInput, sumMoney } from '@/lib/money';
import { SIGN_IN_PATH } from '@/lib/paths';
import { PII_WARNING } from '@/lib/validation';
import { DateField, MoneyField, SelectField, SMALL_BUTTON, TextAreaField } from '@/components/forms/fields';
import { FormError, SubmitButton } from '@/components/forms/form-shell';
import { TextField } from '@/components/forms/text-field';
import { Notice } from '@/components/ui/primitives';

export interface SupplierChoice { readonly id: string; readonly name: string; readonly marketplace: string }
export interface OrderItemChoice { readonly id: string; readonly productName: string; readonly quantity: number }

interface LineRow { key: number; orderItemId: string; quantity: string; unitCost: string }

const LABELS = {
  supplierId: 'Supplier', supplierOrderReference: 'Supplier order reference', purchaseUrl: 'Purchase URL', purchaseDate: 'Purchase date', notes: 'Notes',
  lines: 'Lines', 'lines.orderItemId': 'item', 'lines.quantity': 'quantity', 'lines.unitCost': 'unit cost',
};

export function PurchaseForm({ suppliers, items, etsyOrderId, defaultDate, currency, replacesPurchaseId }: {
  readonly suppliers: readonly SupplierChoice[]; readonly items: readonly OrderItemChoice[];
  readonly etsyOrderId: string; readonly defaultDate: string; readonly currency: string;
  /** A reversed purchase this one corrects; the server records the link in the notes. */
  readonly replacesPurchaseId?: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<LineRow[]>(items.map((item, index) => ({ key: index + 1, orderItemId: item.id, quantity: String(item.quantity), unitCost: '' })));
  const [nextKey, setNextKey] = useState(items.length + 1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (key: number, patch: Partial<LineRow>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const addLine = (orderItemId: string) => { setRows((current) => [...current, { key: nextKey, orderItemId, quantity: '1', unitCost: '' }]); setNextKey(nextKey + 1); };
  const removeLine = (key: number) => setRows((current) => (current.length > 1 ? current.filter((row) => row.key !== key) : current));

  // Exact preview with the same helpers the server uses (no floating point).
  const preview = useMemo(() => rows.map((row) => {
    const unit = parseMoneyInput(row.unitCost);
    const quantity = Number(row.quantity);
    if (unit === null || !Number.isInteger(quantity) || quantity < 1) return null;
    const total = multiplyByQuantity(unit, quantity);
    return isWithinMoneyLimit(total) ? total : null;
  }), [rows]);
  const complete = preview.every((total) => total !== null);
  const grandTotal = complete ? sumMoney(preview.filter((total): total is bigint => total !== null)) : null;
  const itemName = (id: string) => items.find((item) => item.id === id)?.productName ?? 'Item';

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    setPending(true);
    setError(null);
    const result = await callApi<{ purchase: { id: string } }>('/api/v1/purchases', 'POST', {
      supplierId: text('supplierId'),
      supplierOrderReference: text('supplierOrderReference') || null,
      purchaseUrl: text('purchaseUrl'),
      purchaseDate: text('purchaseDate'),
      notes: text('notes'),
      ...(replacesPurchaseId ? { replacesPurchaseId } : {}),
      lines: rows.map((row) => ({ orderItemId: row.orderItemId, quantity: Number(row.quantity), unitCost: row.unitCost.trim() })),
    });
    if (!result.ok) {
      setPending(false);
      if (result.failure.status === 401) router.push(SIGN_IN_PATH);
      else setError(describeFailure(result.failure, LABELS));
      return;
    }
    router.push(`/app/purchases/${result.data.purchase.id}`);
  }

  if (suppliers.length === 0) {
    return <Notice title="Add a supplier first">A purchase needs a supplier. <Link className="underline" href="/app/suppliers">Add one here</Link>, then come back.</Notice>;
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-4xl flex-col gap-5" aria-busy={pending}>
      <FormError message={error} />
      <Notice title={`Draft purchase for Etsy order ${etsyOrderId}`}>
        Saving creates a draft. Nothing counts toward profit until you confirm the purchase. {PII_WARNING}
        {replacesPurchaseId ? ' This purchase replaces a reversed one, so leave the supplier order reference blank or use a new one.' : ''}
      </Notice>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField id="supplierId" name="supplierId" label="Supplier" required defaultValue="" disabled={pending}>
          <option value="" disabled>Choose a supplier</option>
          {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name} ({supplier.marketplace})</option>)}
        </SelectField>
        <DateField id="purchaseDate" name="purchaseDate" label="Purchase date" required defaultValue={defaultDate} disabled={pending} />
        <TextField id="supplierOrderReference" name="supplierOrderReference" label="Supplier order reference (optional)" maxLength={160} pattern="[A-Za-z0-9._:/#\-]+" hint="Unique per supplier. Leave blank when re-entering a corrected purchase." disabled={pending} />
        <TextField id="purchaseUrl" name="purchaseUrl" label="Purchase URL (optional)" type="url" maxLength={2048} disabled={pending} />
      </div>

      <fieldset className="flex flex-col gap-3" disabled={pending}>
        <legend className="mb-1 text-sm font-medium">What you bought ({currency})</legend>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Each line is quantity × unit cost, exactly. If a total does not divide evenly (for example 10.00 for 3 units), split it into lines: 1 × 3.34 and 2 × 3.33.
          Allocate shipping, tax and discounts across the lines yourself.
        </p>
        {rows.map((row, index) => (
          <div key={row.key} className="grid gap-3 rounded-md border border-zinc-300 p-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] dark:border-zinc-700">
            <SelectField id={`line-item-${row.key}`} label={`Line ${index + 1}: item`} value={row.orderItemId} onChange={(event) => update(row.key, { orderItemId: event.target.value })}>
              {items.map((item) => <option key={item.id} value={item.id}>{item.productName} (ordered {item.quantity})</option>)}
            </SelectField>
            <TextField id={`line-qty-${row.key}`} label="Quantity" type="number" min={1} max={100000} step={1} required value={row.quantity} onChange={(event) => update(row.key, { quantity: event.target.value })} />
            <MoneyField id={`line-cost-${row.key}`} label="Unit cost" required value={row.unitCost} onChange={(event) => update(row.key, { unitCost: event.target.value })} />
            <div className="self-end pb-2 text-sm" aria-live="polite">
              <span className="block text-zinc-600 dark:text-zinc-400">Line total</span>
              <span className="tabular-nums">{preview[index] === null ? '—' : formatMoney(preview[index])}</span>
            </div>
            <button type="button" className={`${SMALL_BUTTON} self-end`} onClick={() => removeLine(row.key)} disabled={rows.length === 1} aria-label={`Remove line ${index + 1} (${itemName(row.orderItemId)})`}>Remove</button>
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="button" className={SMALL_BUTTON} onClick={() => addLine(items[0]?.id ?? '')} disabled={rows.length >= 100 || items.length === 0}>Add another line</button>
          <p className="text-sm font-medium" aria-live="polite">Purchase total: <span className="tabular-nums">{grandTotal === null ? '—' : `${formatMoney(grandTotal)} ${currency}`}</span></p>
        </div>
      </fieldset>

      <TextAreaField id="purchase-notes" name="notes" label="Notes (optional)" maxLength={2000} disabled={pending} />
      <SubmitButton pending={pending}>{pending ? 'Saving…' : 'Save draft purchase'}</SubmitButton>
    </form>
  );
}
