import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { PurchaseActions } from '@/components/purchases/purchase-actions';
import { Amount, Notice, PageHeader, PrimaryLink, StatusBadge, TABLE_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/primitives';
import { requireTenant } from '@/server/auth/page-guards';
import { getContainer } from '@/server/container';
import { assertUuidOrNotFound, orNotFound } from '@/server/http/pages';
import { getPurchaseDetail } from '@/server/purchases/service';

export const metadata: Metadata = { title: 'Supplier purchase' };

export default function PurchasePage({ params }: { params: Promise<{ purchaseId: string }> }) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <PurchaseContent params={params} />
    </Suspense>
  );
}

async function PurchaseContent({ params }: { params: Promise<{ purchaseId: string }> }) {
  const tenant = await requireTenant();
  const purchaseId = assertUuidOrNotFound((await params).purchaseId);
  const detail = await orNotFound(getPurchaseDetail(getContainer().db, tenant, purchaseId));
  const { purchase, lines, warnings } = detail;
  const firstOrderId = lines[0]?.orderId;
  return (
    <>
      <PageHeader
        title={`Purchase from ${purchase.supplierName}`}
        description={`${purchase.purchaseDate ?? 'No date'}${purchase.supplierOrderReference ? ` · reference ${purchase.supplierOrderReference}` : ''}`}
        actions={purchase.effectiveStatus === 'REVERSED' && firstOrderId
          ? <PrimaryLink href={`/app/purchases/new?orderId=${firstOrderId}&replaces=${purchase.id}`}>Record corrected purchase</PrimaryLink> : null}
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={purchase.effectiveStatus} />
        <span className="text-sm">Total <Amount value={purchase.totalAmount} currency={purchase.currency} /></span>
      </div>

      {purchase.effectiveStatus === 'DRAFT' ? <div className="mb-6"><Notice title="Draft">This purchase is not counted in profit and nothing has been posted to the ledger. Confirm it when the purchase is final.</Notice></div> : null}
      {detail.confirmBlockedReason === 'ORDER_CANCELLED' ? <div className="mb-6"><Notice tone="warning" title="Cannot be confirmed">This draft covers a cancelled order. Cancelled orders cannot receive supplier costs. Cancel this draft, or remove those lines by editing it through the API (a form for that comes later).</Notice></div> : null}
      {purchase.effectiveStatus === 'CONFIRMED' ? <div className="mb-6"><Notice>Confirmed {purchase.confirmedDate}: this cost counts toward profit and is recorded in the ledger as owed to the supplier until you settle it in a later phase.</Notice></div> : null}
      {purchase.effectiveStatus === 'REVERSED' ? <div className="mb-6"><Notice tone="warning" title="Reversed">This purchase was reversed with an exact opposite entry and no longer counts toward profit. The original entry is kept for the record.</Notice></div> : null}
      {warnings.map((warning) => (
        <div key={warning.orderItemId} className="mb-3">
          <Notice tone="warning" title="More bought than ordered">{warning.productName}: {warning.purchasedQuantity} bought across purchases, {warning.orderedQuantity} ordered. This is allowed, for example for replacements.</Notice>
        </div>
      ))}

      <section aria-labelledby="lines" className="mb-8">
        <h2 id="lines" className="mb-2 text-lg font-semibold">Lines</h2>
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <caption className="sr-only">Purchase lines</caption>
            <thead><tr>
              <th scope="col" className={TH_CLASS}>Item</th><th scope="col" className={TH_CLASS}>Etsy order</th>
              <th scope="col" className={`${TH_CLASS} text-right`}>Quantity</th><th scope="col" className={`${TH_CLASS} text-right`}>Unit cost</th><th scope="col" className={`${TH_CLASS} text-right`}>Line total</th>
            </tr></thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td className={TD_CLASS}>{line.productName}</td>
                  <td className={TD_CLASS}><Link className="underline" href={`/app/orders/${line.orderId}`}>{line.etsyOrderId}</Link></td>
                  <td className={`${TD_CLASS} text-right`}>{line.quantity}</td>
                  <td className={`${TD_CLASS} text-right`}><Amount value={line.unitCost} /></td>
                  <td className={`${TD_CLASS} text-right`}><Amount value={line.totalCost} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th scope="row" colSpan={4} className={`${TD_CLASS} text-right font-semibold`}>Total</th><td className={`${TD_CLASS} text-right font-semibold`}><Amount value={purchase.totalAmount} currency={purchase.currency} /></td></tr></tfoot>
          </table>
        </div>
      </section>

      {purchase.purchaseUrl ? <p className="mb-6 text-sm break-all">Purchase link: {purchase.purchaseUrl}</p> : null}
      {purchase.notes ? <div className="mb-6"><Notice title="Notes"><span className="whitespace-pre-line">{purchase.notes}</span></Notice></div> : null}

      <PurchaseActions
        purchaseId={purchase.id}
        totalLabel={`${purchase.totalAmount} ${purchase.currency}`}
        canConfirm={detail.canConfirm} canCancel={detail.canCancel} canReverse={detail.canReverse} canEdit={detail.canEdit}
      />
    </>
  );
}
