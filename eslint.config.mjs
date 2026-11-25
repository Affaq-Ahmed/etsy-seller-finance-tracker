import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The database runner and Node test fixtures intentionally use CommonJS.
    files: ["scripts/**/*.cjs", "tests/**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Tenant data boundary (ARCHITECTURE.md §7.2): only the DAL, auth, db and
    // composition-root modules may touch the database. Also checked by
    // tests/app/unit/static-guards.test.ts.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/db/**", "src/server/db/**", "src/server/dal/**", "src/server/auth/**", "src/server/container.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        patterns: [
          { group: ["@/db/*", "**/db/schema", "**/db/auth-schema"], message: "Only the DAL, auth and db modules may import the schema." },
          { group: ["drizzle-orm", "drizzle-orm/*", "postgres"], message: "Only the DAL, auth and db modules may use the database driver." },
          { group: ["@/server/db/client"], allowTypeImports: true, message: "Use DAL functions; only types may be imported from the database client." },
        ],
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
