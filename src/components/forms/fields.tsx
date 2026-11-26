import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const CONTROL = 'rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-60 dark:border-zinc-600';

interface Common { readonly id: string; readonly label: string; readonly hint?: string }

function Wrapper({ id, label, hint, children }: Common & { readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children}
      {hint ? <p id={`${id}-hint`} className="text-sm text-zinc-600 dark:text-zinc-400">{hint}</p> : null}
    </div>
  );
}

export function SelectField({ id, label, hint, children, ...rest }: Common & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'className'>) {
  return (
    <Wrapper id={id} label={label} hint={hint}>
      <select id={id} aria-describedby={hint ? `${id}-hint` : undefined} className={CONTROL} {...rest}>{children}</select>
    </Wrapper>
  );
}

export function TextAreaField({ id, label, hint, ...rest }: Common & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'className'>) {
  return (
    <Wrapper id={id} label={label} hint={hint}>
      <textarea id={id} aria-describedby={hint ? `${id}-hint` : undefined} rows={3} className={CONTROL} {...rest} />
    </Wrapper>
  );
}

/** Amount input: decimal keyboard on phones, at most two decimals (validated again by the server). */
export function MoneyField({ id, label, hint, ...rest }: Common & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'type' | 'inputMode' | 'pattern'>) {
  return (
    <Wrapper id={id} label={label} hint={hint}>
      <input id={id} type="text" inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" autoComplete="off" aria-describedby={hint ? `${id}-hint` : undefined} className={`${CONTROL} tabular-nums`} {...rest} />
    </Wrapper>
  );
}

export function DateField({ id, label, hint, ...rest }: Common & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'type'>) {
  return (
    <Wrapper id={id} label={label} hint={hint}>
      <input id={id} type="date" aria-describedby={hint ? `${id}-hint` : undefined} className={CONTROL} {...rest} />
    </Wrapper>
  );
}

export const SMALL_BUTTON = 'rounded-md border border-zinc-400 px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-60 dark:border-zinc-600';
