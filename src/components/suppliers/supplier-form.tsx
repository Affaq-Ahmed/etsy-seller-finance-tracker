'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi, describeFailure } from '@/lib/api-client';
import { SIGN_IN_PATH } from '@/lib/paths';
import { PII_WARNING } from '@/lib/validation';
import { SelectField, TextAreaField } from '@/components/forms/fields';
import { FormError, SubmitButton } from '@/components/forms/form-shell';
import { TextField } from '@/components/forms/text-field';

const MARKETPLACES: ReadonlyArray<readonly [string, string]> = [
  ['EBAY', 'eBay'], ['AMAZON', 'Amazon'], ['ALIEXPRESS', 'AliExpress'], ['CUSTOM', 'Custom supplier'],
];
const LABELS = { name: 'Name', marketplace: 'Marketplace', websiteUrl: 'Website', notes: 'Notes' };

export function SupplierForm() {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await callApi('/api/v1/suppliers', 'POST', {
      name: String(data.get('name') ?? ''), marketplace: String(data.get('marketplace') ?? ''),
      websiteUrl: String(data.get('websiteUrl') ?? ''), notes: String(data.get('notes') ?? ''),
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
      <TextField id="supplier-name" name="name" label="Supplier name" required maxLength={240} disabled={pending} />
      <SelectField id="supplier-marketplace" name="marketplace" label="Marketplace" defaultValue="EBAY" disabled={pending}>
        {MARKETPLACES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </SelectField>
      <TextField id="supplier-url" name="websiteUrl" label="Website (optional)" type="url" maxLength={2048} disabled={pending} />
      <TextAreaField id="supplier-notes" name="notes" label="Notes (optional)" maxLength={2000} disabled={pending} hint={PII_WARNING} />
      <SubmitButton pending={pending}>{pending ? 'Adding…' : 'Add supplier'}</SubmitButton>
    </form>
  );
}

