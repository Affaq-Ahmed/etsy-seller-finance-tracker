import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { is, Table } from 'drizzle-orm';
import * as schema from '@/db/schema';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SRC = path.join(ROOT, 'src');

function files(dir: string, pattern: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full, pattern);
    return pattern.test(entry.name) ? [full] : [];
  });
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');
const read = (file: string) => fs.readFileSync(file, 'utf8');
const sourceFiles = files(SRC, /\.(ts|tsx)$/);
const DB_ALLOWED = /^src\/(db\/|server\/db\/|server\/dal\/|server\/auth\/|server\/container\.ts$)/;

/** Static `import ... from '<spec>'` statements with their imported names. */
function imports(source: string): { spec: string; names: string[]; typeOnly: boolean }[] {
  const out: { spec: string; names: string[]; typeOnly: boolean }[] = [];
  // Import clauses never contain quotes or semicolons, so side-effect imports
  // (`import 'server-only';`) cannot be swallowed into the next statement.
  const re = /import\s+(type\s+)?([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(re)) {
    const clause = match[2] ?? '';
    const names = [...clause.matchAll(/\{([^}]*)\}/g)].flatMap((m) => (m[1] ?? '').split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '').filter(Boolean));
    if (/\*\s+as\s+/.test(clause)) names.push('*');
    out.push({ spec: match[3] ?? '', names, typeOnly: Boolean(match[1]) });
  }
  return out;
}

describe('T17 static guards', () => {
  it('every API route handler is session/tenant guarded or annotated public', () => {
    const routes = files(path.join(SRC, 'app'), /^route\.ts$/);
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const file of routes) {
      const source = read(file);
      const guarded = /\b(sessionRoute|tenantRoute)\(/.test(source);
      const isPublic = /^\/\/ public: \S/m.test(source);
      expect(guarded || isPublic, `${rel(file)} must use sessionRoute/tenantRoute or carry a "// public:" annotation`).toBe(true);
    }
  });

  it('every page calls a page guard itself or is annotated public', () => {
    const pages = files(path.join(SRC, 'app'), /^page\.tsx$/);
    for (const file of pages) {
      const source = read(file);
      const guarded = /\b(requireTenant|requireSession|requireOnboardingSession)\(/.test(source);
      const isPublic = /^\/\/ public: \S/m.test(source);
      expect(guarded || isPublic, `${rel(file)} must call a page guard or carry a "// public:" annotation`).toBe(true);
    }
  });

  it('only the DAL, auth, db and container modules touch the database', () => {
    for (const file of sourceFiles) {
      const name = rel(file);
      if (DB_ALLOWED.test(name)) continue;
      for (const imp of imports(read(file))) {
        const forbidden = /^(@\/db\/|drizzle-orm|postgres$)/.test(imp.spec) || (imp.spec === '@/server/db/client' && !imp.typeOnly);
        expect(forbidden, `${name} imports ${imp.spec}`).toBe(false);
      }
    }
  });

  it('TenantId values are created only by the session resolver', () => {
    for (const file of sourceFiles) {
      const name = rel(file);
      if (name === 'src/server/auth/session.ts') continue;
      expect(/as\s+TenantId\b/.test(read(file)), `${name} casts to TenantId`).toBe(false);
      expect(/brandTenantId/.test(read(file)), `${name} references brandTenantId`).toBe(false);
    }
  });

  it('client components never import server modules', () => {
    for (const file of sourceFiles) {
      const source = read(file);
      if (!/^['"]use client['"]/m.test(source)) continue;
      for (const imp of imports(source)) {
        expect(/^@\/(server|db)\//.test(imp.spec), `${rel(file)} imports ${imp.spec}`).toBe(false);
      }
    }
  });

  it('all server modules are marked server-only', () => {
    for (const file of files(path.join(SRC, 'server'), /\.ts$/)) {
      const name = rel(file);
      if (name === 'src/server/auth/tenant-context.ts' || name === 'src/server/db/errors.ts') continue; // types / pure helpers only
      expect(/^import 'server-only';/m.test(read(file)), `${name} must import 'server-only'`).toBe(true);
    }
  });
});

describe('T18 cache safety', () => {
  it('no cache directive anywhere in src (session and tenant data are never cached)', () => {
    for (const file of sourceFiles) {
      // A directive is a statement on its own line; comments that mention it do not count.
      expect(/^\s*['"]use cache(:\s*[\w-]+)?['"];?\s*$/m.test(read(file)), `${rel(file)} uses a cache directive`).toBe(false);
    }
  });

  it('no route segment caching overrides on API routes', () => {
    for (const file of files(path.join(SRC, 'app', 'api'), /^route\.ts$/)) {
      expect(/export const (revalidate|dynamic|fetchCache)\b/.test(read(file)), `${rel(file)} overrides caching`).toBe(false);
    }
  });
});

describe('T16 tenant table coverage meta-test', () => {
  const exportsOfSchema: unknown[] = Object.values(schema);
  const tables = exportsOfSchema.filter((value): value is PgTable => is(value, Table));
  const tenantTables = tables
    .map((table) => getTableConfig(table))
    .filter((config) => config.columns.some((column) => column.name === 'account_id') && config.name !== 'account')
    .map((config) => config.name)
    .sort();

  // Tables this milestone exposes through the DAL, with their DAL module.
  const EXPOSED: Record<string, string> = {
    account_settings: 'src/server/dal/account-settings.ts',
    financial_accounts: 'src/server/dal/financial-accounts.ts',
    audit_logs: 'src/server/dal/audit-logs.ts',
  };
  const exportName = (tableName: string) => Object.entries(schema).find(([, value]) => is(value, Table) && getTableConfig(value as PgTable).name === tableName)?.[0];

  it('finds all 34 tenant-owned tables', () => {
    expect(tenantTables).toHaveLength(34);
  });

  it('every exposed tenant table has a DAL module and cross-tenant tests', () => {
    const isolationTests = read(path.join(ROOT, 'tests/app/db/tenant-isolation.test.ts'));
    for (const [table, dalModule] of Object.entries(EXPOSED)) {
      expect(tenantTables).toContain(table);
      const name = exportName(table);
      expect(name, `${table} export`).toBeDefined();
      expect(fs.existsSync(path.join(ROOT, dalModule)), `${dalModule} exists`).toBe(true);
      expect(read(path.join(ROOT, dalModule))).toContain(name);
      expect(isolationTests, `cross-tenant tests cover ${table}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('tables not yet exposed are imported by no application code', () => {
    const notExposed = new Set(tenantTables.filter((table) => !(table in EXPOSED)).map((table) => exportName(table)));
    expect(notExposed.size).toBe(31);
    for (const file of sourceFiles) {
      const name = rel(file);
      if (name.startsWith('src/db/')) continue;
      for (const imp of imports(read(file))) {
        if (imp.spec !== '@/db/schema') continue;
        for (const imported of imp.names) {
          if (imported === '*') {
            expect(name, 'only the db client may import the whole schema').toBe('src/server/db/client.ts');
            continue;
          }
          expect(notExposed.has(imported), `${name} imports unexposed tenant table ${imported}`).toBe(false);
        }
      }
    }
  });
});
