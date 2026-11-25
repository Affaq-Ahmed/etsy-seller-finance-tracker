import { loadEnvConfig } from '@next/env';
import { defineConfig } from 'drizzle-kit';

// Match Next.js precedence, including .env.local, without opening a connection.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Offline generation/checking needs no URL. Kit validates credentials for
  // commands that actually require a database; never invent a fallback URL.
  ...(process.env.DATABASE_URL
    ? { dbCredentials: { url: process.env.DATABASE_URL } }
    : {}),
  strict: true,
  verbose: true,
});
