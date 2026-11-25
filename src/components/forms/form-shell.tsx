import type { ReactNode } from 'react';

export function FormShell({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function FormError({ message }: { readonly message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-red-700 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:text-red-400">
      {message}
    </p>
  );
}

export function SubmitButton({ pending, children }: { readonly pending: boolean; readonly children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="rounded-md bg-zinc-900 px-4 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
    >
      {children}
    </button>
  );
}
