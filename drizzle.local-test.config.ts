import { defineConfig } from 'drizzle-kit';
import { validateLocalTestDatabase } from './tests/helpers/local-database.cjs';

// Intentionally does not load dotenv, @next/env, DATABASE_URL or .env.local.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: validateLocalTestDatabase() },
  strict: true,
  verbose: false,
});
