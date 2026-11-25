import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Same safety rules as the node:test suites: loopback only, etsy_finance_test_*
// database, explicitly disposable. DATABASE_URL is never read.
const { validateLocalTestDatabase } = require('../../helpers/local-database.cjs') as {
  validateLocalTestDatabase(url?: string): string;
};

/** True only when run through `node scripts/local-db.cjs run ...`. */
export const hasTestDatabase = Boolean(process.env.LOCAL_TEST_DATABASE_URL);

export function testDatabaseUrl(): string {
  return validateLocalTestDatabase();
}
