import Link from 'next/link';
import type { ReactNode } from 'react';

export function PageHeader({ title, description, actions }: { readonly title: string; readonly description?: string; readonly actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

const LINK_BUTTON = 'inline-block rounded-md px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600';

export function PrimaryLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return <Link href={href} className={`${LINK_BUTTON} bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900`}>{children}</Link>;
}

export function SecondaryLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return <Link href={href} className={`${LINK_BUTTON} border border-zinc-400 dark:border-zinc-600`}>{children}</Link>;
}

export function Notice({ tone = 'info', title, children }: { readonly tone?: 'info' | 'warning'; readonly title?: string; readonly children: ReactNode }) {
  const palette = tone === 'warning'
    ? 'border-amber-700 text-amber-900 dark:border-amber-400 dark:text-amber-200'
    : 'border-zinc-400 text-zinc-800 dark:border-zinc-600 dark:text-zinc-200';
  return (
    <div role={tone === 'warning' ? 'alert' : 'note'} className={`rounded-md border px-3 py-2 text-sm ${palette}`}>
      {title ? <p className="font-medium">{title}</p> : null}
      {children}
    </div>
  );
}

const BADGE_TONES: Readonly<Record<string, string>> = {
  DRAFT: 'border-zinc-500 text-zinc-700 dark:text-zinc-300',
  CONFIRMED: 'border-green-700 text-green-800 dark:border-green-400 dark:text-green-300',
  DELIVERED: 'border-green-700 text-green-800 dark:border-green-400 dark:text-green-300',
  REVERSED: 'border-amber-700 text-amber-900 dark:border-amber-400 dark:text-amber-200',
  CANCELLED: 'border-red-700 text-red-800 dark:border-red-400 dark:text-red-300',
};

/** Status as readable text (never colour alone). */
export function StatusBadge({ status }: { readonly status: string }) {
  const tone = BADGE_TONES[status] ?? 'border-blue-700 text-blue-800 dark:border-blue-400 dark:text-blue-300';
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${tone}`}>{status.replaceAll('_', ' ')}</span>;
}

export function Amount({ value, currency }: { readonly value: string; readonly currency?: string }) {
  return <span className="tabular-nums">{value}{currency ? ` ${currency}` : ''}</span>;
}

export function EmptyState({ children }: { readonly children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-zinc-400 px-4 py-8 text-center text-sm text-zinc-600 dark:border-zinc-600 dark:text-zinc-400">{children}</p>;
}

export function Pager({ basePath, offset, limit, total }: { readonly basePath: string; readonly offset: number; readonly limit: number; readonly total: number }) {
  if (total <= limit) return null;
  const previous = Math.max(0, offset - limit);
  const next = offset + limit;
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm">
      <span>{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
      <span className="flex gap-3">
        {offset > 0 ? <Link className="underline" href={previous === 0 ? basePath : `${basePath}?offset=${previous}`}>Previous</Link> : null}
        {next < total ? <Link className="underline" href={`${basePath}?offset=${next}`}>Next</Link> : null}
      </span>
    </nav>
  );
}

export const TABLE_CLASS = 'w-full border-collapse text-left text-sm';
export const TH_CLASS = 'border-b border-zinc-400 px-2 py-2 font-medium dark:border-zinc-600';
export const TD_CLASS = 'border-b border-zinc-200 px-2 py-2 align-top dark:border-zinc-800';
