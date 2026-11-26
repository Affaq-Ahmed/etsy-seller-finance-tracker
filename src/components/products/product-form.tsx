'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi, describeFailure } from '@/lib/api-client';
import { SIGN_IN_PATH } from '@/lib/paths';
import { PII_WARNING } from '@/lib/validation';
import { MoneyField, SelectField, TextAreaField } from '@/components/forms/fields';
import { FormError, SubmitButton } from '@/components/forms/form-shell';
import { TextField } from '@/components/forms/text-field';

export interface SupplierOption { readonly id: string; readonly name: string }

const LABELS = { name: 'Name', sku: 'SKU', imageUrl: 'Image URL', defaultSupplierId: 'Default supplier', defaultUnitCost: 'Default cost', notes: 'Notes' };

export function ProductForm({ suppliers, currency }: { readonly suppliers: readonly SupplierOption[]; readonly currency: string }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    setPending(true);
    setError(null);
    const result = await callApi('/api/v1/products', 'POST', {
      name: text('name'),
      ...(text('sku') ? { sku: text('sku') } : {}),
      ...(text('imageUrl') ? { imageUrl: text('imageUrl') } : {}),
      defaultSupplierId: text('defaultSupplierId') || null,
      defaultUnitCost: text('defaultUnitCost') || null,
      notes: text('notes'),
    });
    setPending(false);
    if (!result.ok) {
      if (result.failure.status === 401) router.push(SIGN_IN_PATH);
      else setError(describeFailure(result.failure, LABELS));
      return;
    }
    form.current?.reset();
    router.refresh();
  }

  return (
    <form ref={form} onSubmit={onSubmit} className="flex max-w-lg flex-col gap-4" aria-busy={pending}>
      <FormError message={error} />
      <TextField id="product-name" name="name" label="Product name" required maxLength={240} disabled={pending} />
      <TextField id="product-sku" name="sku" label="SKU (optional)" maxLength={100} hint="Letters, digits, dots, dashes and underscores. Unique per business." disabled={pending} />
      <TextField id="product-image" name="imageUrl" label="Image URL (optional)" type="url" maxLength={2048} disabled={pending} />
      <SelectField id="product-supplier" name="defaultSupplierId" label="Default supplier (optional)" defaultValue="" disabled={pending}>
        <option value="">None</option>
        {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
      </SelectField>
      <MoneyField id="product-cost" name="defaultUnitCost" label={`Default unit cost, ${currency} (optional)`} disabled={pending}
        hint="For your reference only. It is never used as an actual cost and never affects profit." />
      <TextAreaField id="product-notes" name="notes" label="Notes (optional)" maxLength={2000} disabled={pending} hint={PII_WARNING} />
      <SubmitButton pending={pending}>{pending ? 'Adding…' : 'Add product'}</SubmitButton>
    </form>
  );
}
