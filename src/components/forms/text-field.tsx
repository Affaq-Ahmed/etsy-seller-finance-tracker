import type { InputHTMLAttributes } from 'react';

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'> & {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
};

export function TextField({ id, label, hint, ...input }: TextFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        aria-describedby={hintId}
        className="rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-60 dark:border-zinc-600"
        {...input}
      />
      {hint ? (
        <p id={hintId} className="text-sm text-zinc-600 dark:text-zinc-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
