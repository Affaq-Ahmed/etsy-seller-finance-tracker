import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { AppContainer } from '@/server/container';
import { NO_STORE } from '@/server/http/responses';
import { hasTestDatabase } from '../support/database';
import { apiRequest, apiRoutes, createTestApp, registerAndOnboard, type OnboardedUser } from '../support/app';
import { auditCount, openRaw } from '../support/phase2';

describe.skipIf(!hasTestDatabase)('suppliers and products', () => {
  let app: AppContainer;
  let raw: postgres.Sql;
  let routes: ReturnType<typeof apiRoutes>;
  let user: OnboardedUser;

  beforeAll(async () => {
    app = createTestApp();
    raw = openRaw();
    routes = apiRoutes(app);
    user = await registerAndOnboard(app, 'Catalog Shop', 'catalog');
  });
  afterAll(async () => {
    await raw?.end();
    await app?.close();
  });

  const send = (handler: ReturnType<typeof apiRoutes>['suppliers']['create'], path: string, body: unknown, who: OnboardedUser = user) =>
    handler(apiRequest(app, path, { method: 'POST', cookie: who.cookie, body }));
  const list = async (handler: ReturnType<typeof apiRoutes>['suppliers']['list'], path: string, query = '?limit=100') =>
    (await handler(apiRequest(app, path, { cookie: user.cookie, query }))).json();

  describe('suppliers', () => {
    it.each([['EBAY'], ['AMAZON'], ['ALIEXPRESS'], ['CUSTOM']])('accepts the %s marketplace', async (marketplace) => {
      const response = await send(routes.suppliers.create, '/api/v1/suppliers', { name: `${marketplace} seller`, marketplace });
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe(NO_STORE);
      expect((await response.json()).supplier).toMatchObject({ name: `${marketplace} seller`, marketplace, websiteUrl: null, notes: null });
    });

    it.each([
      ['an unknown marketplace', { name: 'X', marketplace: 'ETSY' }, ['marketplace']],
      ['a lower-case marketplace', { name: 'X', marketplace: 'ebay' }, ['marketplace']],
      ['a missing name', { marketplace: 'EBAY' }, ['name']],
      ['a blank name', { name: '   ', marketplace: 'EBAY' }, ['name']],
      ['a non-http website', { name: 'X', marketplace: 'EBAY', websiteUrl: 'ftp://x.example' }, ['websiteUrl']],
      ['an email in notes', { name: 'X', marketplace: 'EBAY', notes: 'contact seller@example.com' }, ['notes']],
      ['a phone number as a name', { name: '+92 300 1234567', marketplace: 'EBAY' }, ['name']],
      ['an unknown field', { name: 'X', marketplace: 'EBAY', accountId: 'x' }, ['accountId']],
    ])('rejects %s', async (_label, body, fields) => {
      const response = await send(routes.suppliers.create, '/api/v1/suppliers', body);
      expect(response.status).toBe(400);
      expect((await response.json()).error.fields).toEqual(fields);
    });

    it('lists alphabetically, audits creation and never exposes the tenant', async () => {
      const lister = await registerAndOnboard(app, 'Supplier List Shop', 'catalog-suppliers');
      for (const name of ['Zeta', 'Alpha', 'Mid']) await send(routes.suppliers.create, '/api/v1/suppliers', { name, marketplace: 'CUSTOM' }, lister);
      const page = await (await routes.suppliers.list(apiRequest(app, '/api/v1/suppliers', { cookie: lister.cookie }))).json();
      expect(page.items.map((supplier: { name: string }) => supplier.name)).toEqual(['Alpha', 'Mid', 'Zeta']);
      expect(page.page).toEqual({ limit: 25, offset: 0, total: 3 });
      expect(JSON.stringify(page)).not.toContain(lister.tenant.accountId);
      expect(await auditCount(raw, lister.tenant.accountId, 'supplier', 'CREATE')).toBe(3);
    });
  });

  describe('products', () => {
    it('creates a product in the business currency, keeping the default cost informational', async () => {
      const supplier = (await (await send(routes.suppliers.create, '/api/v1/suppliers', { name: 'Default supplier', marketplace: 'AMAZON' })).json()).supplier;
      const response = await send(routes.products.create, '/api/v1/products', {
        name: 'Ceramic Mug', sku: 'MUG-CAT-1', imageUrl: 'https://img.example/mug.jpg', defaultSupplierId: supplier.id, defaultUnitCost: '4.50', notes: 'Blue glaze',
      });
      expect(response.status).toBe(201);
      expect((await response.json()).product).toMatchObject({
        name: 'Ceramic Mug', sku: 'MUG-CAT-1', defaultSupplierId: supplier.id, defaultUnitCost: '4.50', currency: 'USD', notes: 'Blue glaze',
      });
      // A product, however priced, creates no expense and no journal entry.
      expect(await raw`SELECT 1 FROM journal_entries WHERE account_id = ${user.tenant.accountId} AND source_type IN ('expense', 'supplier_purchase')`).toHaveLength(0);
      expect(await raw`SELECT 1 FROM expenses WHERE account_id = ${user.tenant.accountId}`).toHaveLength(0);
    });

    it('stores products without optional fields', async () => {
      const response = await send(routes.products.create, '/api/v1/products', { name: 'Plain' });
      expect((await response.json()).product).toMatchObject({ sku: null, imageUrl: null, defaultSupplierId: null, defaultUnitCost: null });
    });

    it('answers 409 naming sku for a duplicate SKU within a tenant, but allows it in another', async () => {
      expect((await send(routes.products.create, '/api/v1/products', { name: 'A', sku: 'DUP-1' })).status).toBe(201);
      const duplicate = await send(routes.products.create, '/api/v1/products', { name: 'B', sku: 'DUP-1' });
      expect(duplicate.status).toBe(409);
      expect((await duplicate.json()).error).toMatchObject({ code: 'DUPLICATE_SKU', fields: ['sku'] });
      const other = await registerAndOnboard(app, 'Other Catalog', 'catalog-other');
      expect((await send(routes.products.create, '/api/v1/products', { name: 'A', sku: 'DUP-1' }, other)).status).toBe(201);
    });

    it('allows several products without a SKU', async () => {
      for (const name of ['No SKU one', 'No SKU two']) expect((await send(routes.products.create, '/api/v1/products', { name })).status).toBe(201);
    });

    it.each([
      ['a name over 240 characters', { name: 'x'.repeat(241) }, ['name']],
      ['a SKU with spaces', { name: 'X', sku: 'has space' }, ['sku']],
      ['a three-decimal default cost', { name: 'X', defaultUnitCost: '1.234' }, ['defaultUnitCost']],
      ['a negative default cost', { name: 'X', defaultUnitCost: '-1' }, ['defaultUnitCost']],
      ['a non-UUID supplier', { name: 'X', defaultSupplierId: 'abc' }, ['defaultSupplierId']],
      ['an image URL with credentials', { name: 'X', imageUrl: 'https://u:p@x.example/a.png' }, ['imageUrl']],
      ['a phone number in notes', { name: 'X', notes: 'call 0300-1234567' }, ['notes']],
      ['a forged currency', { name: 'X', currency: 'PKR' }, ['currency']],
    ])('rejects %s', async (_label, body, fields) => {
      const response = await send(routes.products.create, '/api/v1/products', body);
      expect(response.status).toBe(400);
      expect((await response.json()).error.fields).toEqual(fields);
    });

    it('lists with stable pagination', async () => {
      const lister = await registerAndOnboard(app, 'Product List Shop', 'catalog-products');
      for (const name of ['Cup', 'Ashtray', 'Bowl']) await send(routes.products.create, '/api/v1/products', { name }, lister);
      const first = await (await routes.products.list(apiRequest(app, '/api/v1/products', { cookie: lister.cookie, query: '?limit=2' }))).json();
      expect(first.items.map((product: { name: string }) => product.name)).toEqual(['Ashtray', 'Bowl']);
      expect(first.page.total).toBe(3);
      const second = await (await routes.products.list(apiRequest(app, '/api/v1/products', { cookie: lister.cookie, query: '?limit=2&offset=2' }))).json();
      expect(second.items.map((product: { name: string }) => product.name)).toEqual(['Cup']);
      expect(await list(routes.products.list, '/api/v1/products')).toHaveProperty('page.total');
    });
  });
});
