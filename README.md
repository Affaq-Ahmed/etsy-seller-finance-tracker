# Etsy Seller Finance Tracker

A multi-tenant financial SaaS for Etsy sellers. It tracks orders, supplier purchases, Etsy payouts, Payoneer transactions, USD→PKR bank withdrawals, expenses, refunds and profitability. The stack is Next.js 16, TypeScript, PostgreSQL, Drizzle ORM and Better Auth, and it targets zero-cost infrastructure.

**Status:** the V1 database foundation and authentication with tenant isolation are implemented and verified locally; financial features have not started and nothing is deployed. See [STATUS.md](docs/STATUS.md).

## Documentation

Baseline documents (the source of truth):

- [PRODUCT.md](docs/PRODUCT.md): scope, user journeys, business and financial rules, product decisions
- [ARCHITECTURE.md](docs/ARCHITECTURE.md): architecture, data and ledger model, security, deployment, decision log
- [DEVELOPMENT.md](docs/DEVELOPMENT.md): setup, environment variables, commands, testing, migration workflow
- [STATUS.md](docs/STATUS.md): milestone, verification results, blockers, next tasks

Owner reference specifications: [PRD v1.2](docs/PRD.md), [System Architecture v1.1](docs/System_Architecture.md), [Database ERD v1.2](docs/Database_ERD.md).

Engineering rules for contributors and agents: [AGENTS.md](AGENTS.md).

## Quick start

```bash
npm ci
npx tsc --noEmit && npm run lint && npm run test:db:offline
```

Database integration tests run only against a disposable local container. See [DEVELOPMENT.md §5.4](docs/DEVELOPMENT.md#54-disposable-local-database). Never use `drizzle-kit push`, and never edit migrations `0000–0009`.
