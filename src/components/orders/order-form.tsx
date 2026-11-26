'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi, describeFailure } from '@/lib/api-client';
import { SIGN_IN_PATH } from '@/lib/paths';
import { PII_WARNING } from '@/lib/validation';
import { DateField, MoneyField, SelectField, SMALL_BUTTON, TextAreaField } from '@/components/forms/fields';
import { FormError, SubmitButton } from '@/components/forms/form-shell';
import { TextField } from '@/components/forms/text-field';
import { Notice } from '@/components/ui/primitives';

export interface ProductOption { readonly id: string; readonly name: string; readonly sku: string | null }

interface ItemRow { key: number; productId: string; productName: string; sku: string; quantity: string }

const LABELS = {
  etsyOrderId: 'Etsy Order ID', orderDate: 'Order date', netPayableAmount: 'Net payable', notes: 'Notes', currency: 'Currency',
  items: 'Items', 'items.quantity': 'quantity', 'items.productId': 'product', 'items.productName': 'item name', 'items.sku': 'SKU',
};

export function OrderForm({ products, defaultDate, currency }: { readonly products: readonly ProductOption[]; readonly defaultDate: string; readonly currency: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<ItemRow[]>([{ key: 1, productId: '', productName: '', sku: '', quantity: '1' }]);
  const [nextKey, setNextKey] = useState(2);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (key: number, patch: Partial<ItemRow>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const addRow = () => { setRows((current) => [...current, { key: nextKey, productId: '', productName: '', sku: '', quantity: '1' }]); setNextKey(nextKey + 1); };
  const removeRow = (key: number) => setRows((current) => (current.length > 1 ? current.filter((row) => row.key !== key) : current));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    setPending(true);
    setError(null);
    // Only business data is sent. The business comes from the signed-in session on the server.
    const result = await callApi<{ order: { id: string } }>('/api/v1/orders', 'POST', {
      etsyOrderId: text('etsyOrderId'),
      orderDate: text('orderDate'),
      netPayableAmount: text('netPayableAmount'),
      notes: text('notes'),
      items: rows.map((row) => (row.productId
        ? { productId: row.productId, quantity: Number(row.quantity) }
        : { productName: row.productName.trim(), ...(row.sku.trim() ? { sku: row.sku.trim() } : {}), quantity: Number(row.quantity) })),
    });
    if (!result.ok) {
      setPending(false);
      if (result.failure.status === 401) router.push(SIGN_IN_PATH);
      else setError(describeFailure(result.failure, LABELS));
      return;
    }
    router.push(`/app/orders/${result.data.order.id}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-3xl flex-col gap-5" aria-busy={pending}>
      <FormError message={error} />
      <Notice title="Enter only what Etsy pays you">
        Use the net amount Etsy pays out for this order. Etsy fees are already taken off, so do not deduct them again. {PII_WARNING}
      </Notice>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="etsyOrderId" name="etsyOrderId" label="Etsy Order ID" required maxLength={120} pattern="[A-Za-z0-9._-]+" hint="Letters, digits, dots, dashes and underscores." disabled={pending} />
        <DateField id="orderDate" name="orderDate" label="Order date" required defaultValue={defaultDate} disabled={pending} />
        <MoneyField id="netPayableAmount" name="netPayableAmount" label={`Net payable from Etsy, ${currency}`} required hint="Up to 2 decimal places." disabled={pending} />
      </div>

      <fieldset className="flex flex-col gap-3" disabled={pending}>
        <legend className="mb-1 text-sm font-medium">Items</legend>
        {rows.map((row, index) => (
          <div key={row.key} className="grid gap-3 rounded-md border border-zinc-300 p-3 sm:grid-cols-[2fr_2fr_1fr_auto] dark:border-zinc-700">
            <SelectField id={`item-product-${row.key}`} label={`Item ${index + 1}: product`} value={row.productId} onChange={(event) => update(row.key, { productId: event.target.value })}>
              <option value="">Custom item (type a name)</option>
              {products.map((product) => <option key={product.id} value={product.id}>{product.name}{product.sku ? ` (${product.sku})` : ''}</option>)}
            </SelectField>
            {row.productId ? (
              <p className="self-end pb-2 text-sm text-zinc-600 dark:text-zinc-400">Name and SKU are copied from the product when the order is saved.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField id={`item-name-${row.key}`} label="Item name" required maxLength={240} value={row.productName} onChange={(event) => update(row.key, { productName: event.target.value })} />
                <TextField id={`item-sku-${row.key}`} label="SKU (optional)" maxLength={100} value={row.sku} onChange={(event) => update(row.key, { sku: event.target.value })} />
              </div>
            )}
            <TextField id={`item-qty-${row.key}`} label="Quantity" type="number" min={1} max={100000} step={1} required value={row.quantity} onChange={(event) => update(row.key, { quantity: event.target.value })} />
            <button type="button" className={`${SMALL_BUTTON} self-end`} onClick={() => removeRow(row.key)} disabled={rows.length === 1} aria-label={`Remove item ${index + 1}`}>Remove</button>
          </div>
        ))}
        <button type="button" className={`${SMALL_BUTTON} self-start`} onClick={addRow} disabled={rows.length >= 50}>Add another item</button>
      </fieldset>

      <TextAreaField id="order-notes" name="notes" label="Notes (optional)" maxLength={2000} hint={PII_WARNING} disabled={pending} />
      <SubmitButton pending={pending}>{pending ? 'Saving…' : 'Save order'}</SubmitButton>
    </form>
  );
}

