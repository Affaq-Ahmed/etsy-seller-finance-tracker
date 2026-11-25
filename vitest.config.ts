import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Application tests (ARCHITECTURE.md decision C1). The node:test database
// suites under tests/*.cjs and tests/integration/ are separate and unchanged.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${fileURLToPath(new URL('./src/', import.meta.url))}` },
      // Next.js handles `server-only` itself; outside Next it is a no-op.
      { find: /^server-only$/, replacement: fileURLToPath(new URL('./tests/app/support/server-only.ts', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/app/**/*.test.ts'],
    // Database files share one disposable database and observe lock waits.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});
