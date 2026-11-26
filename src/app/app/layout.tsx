import Link from 'next/link';
import type { ReactNode } from 'react';
import { SignOutButton } from '@/components/auth/sign-out-button';

// Static navigation only. The layout reads no session and no tenant data: every
// page below calls requireTenant() itself (layouts are not a security boundary).
const LINKS: ReadonlyArray<readonly [string, string]> = [
  ['/app', 'Home'], ['/app/orders', 'Orders'], ['/app/purchases', 'Purchases'], ['/app/suppliers', 'Suppliers'], ['/app/products', 'Products'],
];

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-black">Skip to content</a>
      <header className="border-b border-zinc-300 dark:border-zinc-700">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <nav aria-label="Main">
            <ul className="flex flex-wrap gap-x-5 gap-y-1">
              {LINKS.map(([href, label]) => (
                <li key={href}><Link href={href} className="text-sm font-medium underline-offset-4 hover:underline">{label}</Link></li>
              ))}
            </ul>
          </nav>
          <SignOutButton />
        </div>
      </header>
      <main id="content" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </>
  );
}
