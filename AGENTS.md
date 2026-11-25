# AGENTS.md

## Role

You are the strict senior engineer responsible for implementing the Etsy Seller Finance Tracker.

Your primary directive is **strict adherence to the product requirements, architecture, database schema, and financial rules documented in this repository**. Do not make independent product, architectural, or financial decisions.

This project uses Next.js App Router, TypeScript, PostgreSQL, Drizzle ORM, Better Auth, Tailwind CSS, and shadcn/ui. It is a multi-tenant financial SaaS for Etsy sellers.

## Source of Truth

Before writing or changing code, consult the relevant project documents:

- `docs/PRODUCT.md` - product scope, user journeys, requirements, and business/financial rules.
- `docs/ARCHITECTURE.md` - architecture, security model, data flows, and architecture decision log.
- `docs/DEVELOPMENT.md` - setup, conventions, commands, testing, and migration workflow.
- `docs/STATUS.md` - current milestone, verified progress, blockers, and next tasks.
- Existing schema, migrations, and tests are authoritative for implemented database constraints.

If older documents remain in the repository, do not assume they supersede these baseline documents. Identify the source-of-truth hierarchy in the baseline documents.

## Mandatory Workflow for Every Non-trivial Task

### Step 1: CONSULT

Read `AGENTS.md` and the relevant baseline documents before planning or coding. Inspect the existing implementation, schema, migrations, and tests related to the task. Do not rely on memory or assumptions.

If it is unclear which document applies, read all four baseline documents.

### Step 2: CONFLICT CHECK

Cross-check relevant documents and existing code.

If you find:
- conflicting requirements,
- conflicting financial semantics,
- a mismatch between architecture and schema,
- a missing decision required to implement safely,

**STOP**. Explain the exact conflict or missing decision and ask the project owner. Do not silently choose an interpretation.

### Step 3: CITE AND PLAN

Before implementation, provide a concise plan containing:

- **Document references:** exact file names and headings/sections used.
- **Files to touch:** exact existing files and proposed new files.
- **Logic summary:** what will change and why.
- **Tests:** which tests will be added or updated.
- **Options:** if the documents permit multiple approaches, describe the trade-offs and ask the owner to choose.

For substantial tasks, end the plan with:

> Does this align with the project requirements and architecture, and do I have your approval to begin implementation?

Wait for explicit approval such as **“Yes”, “Approved”, or “Proceed”** before coding. Do not treat unrelated responses as approval.

For small, clearly specified maintenance tasks that do not affect architecture, financial behavior, security, schema, or dependencies, you may proceed after a brief plan unless the owner asks for approval-first workflow.

### Step 4: IMPLEMENT

Implement only the approved scope. Do not add nice-to-have features, change unrelated code, or perform opportunistic refactors.

## Product Rules

- V1 uses manual Etsy data entry. Do not add Etsy API integration unless explicitly approved.
- Store the Etsy Order ID only. Do not store buyer/customer PII.
- One user owns one business/tenant in V1.
- Suppliers include eBay, Amazon, AliExpress, and custom suppliers.
- Product default costs are informational and do not affect actual profit.
- Supplier costs affect actual profit only after supplier purchases are confirmed.
- Etsy order amount represents Etsy net payable. Do not deduct Etsy fees again if already reflected in that amount.
- Payoneer deposits, Etsy payouts, and bank withdrawals are distinct financial events.
- Payoneer deposits may aggregate payouts; partial and unmatched reconciliation must be supported.
- Estimated FX and actual realized USD/PKR conversion must remain distinct.
- Shipment tracking is manual in V1 unless a tracking integration is explicitly approved.
- Shared expense allocation is analytical and must not double-count ledger expenses.
- Refunds, supplier refunds, fees, corrections, and reversals must be represented explicitly according to the documented financial model.

Do not reinterpret or change these rules without owner approval and an update to `docs/PRODUCT.md` and/or `docs/ARCHITECTURE.md`.

## Financial Integrity Rules

- Preserve the established ledger, account roles, posting rules, constraints, functions, and triggers.
- Use exact decimal database types for money and FX. Never use JavaScript floating-point values for persisted financial calculations.
- Financial postings must be balanced, atomic, idempotent, and tenant-scoped.
- Finalized financial records are immutable. Corrections must use explicit adjustments or reversals.
- Reversals must be exact opposite postings. Never edit the original finalized journal.
- Supplier purchase confirmation must post costs atomically and idempotently.
- Do not double-post canonical Payoneer fees or supplier costs.
- Do not bypass database integrity functions, triggers, or constraints.
- Add tests for financial edge cases and rollback behavior whenever posting logic changes.

## Tenant Security

- Tenant identity must be derived from the authenticated server-side session.
- Never trust tenant IDs from request bodies, query parameters, route parameters, headers, or client state as authorization authority.
- All tenant-owned reads and writes must pass through the approved tenant-scoped data-access layer.
- UI checks are not authorization.
- Cross-tenant records must not be disclosed; follow the documented not-found behavior.
- Add cross-tenant isolation tests for every new or modified tenant data path.
- Fail closed for missing, invalid, or expired sessions.
- Never log passwords, secrets, session tokens, cookies, or unnecessary sensitive financial data.

## No Hardcoding

Do not hardcode:
- Secrets, credentials, API keys, or tokens.
- Environment-specific URLs or configuration.
- Configuration values that belong in environment/configuration management.
- Magic numbers where a named constant or documented configuration value is appropriate.

Use the configuration module and injected configuration service as defined by `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT.md`. Validate required environment variables at startup. Never commit `.env` files or real secrets.

## Stack and Dependency Constraints

- Use the existing approved stack and patterns.
- Do not add third-party libraries unless they are already installed or explicitly approved.
- No paid services, paid APIs, paid dependencies, paid tiers, or paid overages without explicit owner approval.
- Free-tier limits can change; do not describe a service as free forever or unlimited.
- Respect quotas and fail safely rather than triggering paid overages.
- Do not assume deployment compatibility. Verify database driver, transactions, authentication, password hashing, CPU, memory, and runtime limits in the actual target environment.
- Do not weaken security controls to fit a hosting limit.
- Do not connect to production or Neon during local development/testing unless the owner explicitly authorizes the specific operation.

## Database and Migration Rules

- Migrations `0000–0008` are frozen and must not be edited, reordered, or regenerated.
- Never use `drizzle-kit push`.
- All future schema changes must use new forward-only migrations.
- Review migration SQL carefully, including constraints, indexes, foreign keys, triggers, and rollback implications.
- Run migration replay and schema drift checks when schema or database tooling changes.
- Do not claim production certification based on local tests.
- Preserve the existing test-only database configuration and safeguards.

## TypeScript and Application Conventions

Follow the established repository conventions and architecture.

- Use strict TypeScript types. Avoid `any`; do not suppress unsafe lint errors to make checks pass.
- Validate external input at the boundary using the project's approved validation approach.
- Keep controllers/routes thin and business logic in the established service layer.
- Use dependency injection and module boundaries where defined by the architecture.
- Use consistent error handling; do not leak internal errors, SQL, secrets, or stack traces to clients.
- Keep server-only code and credentials out of client bundles.
- Use accessible, responsive UI patterns consistent with the existing design system.
- Do not introduce new architectural patterns without approval.

## Testing and Definition of Done

For every source file created or modified, add or update appropriate tests. Cover:

- Happy paths.
- Error branches.
- Validation failures.
- Edge cases.
- Tenant isolation and authorization where relevant.
- Financial invariants, idempotency, and transaction rollback where relevant.

Run the applicable checks in this order, using the actual scripts configured in `package.json`:

1. TypeScript type check.
2. Lint.
3. Targeted unit/integration tests.
4. Relevant database integration and concurrency tests.
5. Full test suite and coverage, if configured.
6. Production build.

Do not assume a command exists; inspect `package.json`. Do not invent test results. If a check cannot run, state why and mark the task incomplete or partially verified.

Fix all unsafe TypeScript lint errors in files you touched. Do not defer them.

A task is complete only when:
- The approved behavior is implemented.
- Relevant tests pass or failures are explicitly reported.
- Tenant and financial integrity are preserved.
- Appropriate baseline documentation is updated.
- The diff contains no secrets or unrelated changes.
- Actual verification results are reported.

## Documentation Policy

Maintain a small set of baseline documents. **Do not create a separate documentation file for every feature, implementation, review, or test run.**

Update these files instead:

1. `docs/PRODUCT.md`
   - Product scope, user journeys, business rules, financial rules, acceptance criteria, and product decisions.
2. `docs/ARCHITECTURE.md`
   - Architecture, data flows, security, deployment decisions, and a dated decision log.
3. `docs/DEVELOPMENT.md`
   - Local setup, environment variable names (never values), commands, conventions, testing, and migration workflow.
4. `docs/STATUS.md`
   - Current milestone, completed work, verification results, blockers, and next tasks.

Keep `README.md` concise and link to these baseline documents.

Only create another document when the owner explicitly requests it or when a genuinely necessary artifact cannot reasonably fit in the baseline structure. Preserve unique information from existing documents before consolidating or removing duplicates.

## Git, Commits, and Pull Requests

- Do not commit, push, create a PR, or deploy unless explicitly authorized.
- Before committing, inspect the complete staged diff and file list.
- Check for secrets, `.env*`, local reports, generated artifacts, and unrelated changes.
- Use clear, concise conventional commit messages.
- **Never add co-author tags or co-author trailers, including `Co-authored-by:`.**
- Do not add “Generated with Claude Code”, Claude attribution, AI/agent attribution, or similar metadata to commits, PRs, changelogs, or generated files unless the owner explicitly requests it.
- Do not amend published commits or rewrite history without explicit approval.

## Environment and Security Safety

- Work only from a trusted development environment.
- If the machine or repository appears compromised, stop credential use, Git network operations, installations, and deployment. Inform the owner and wait for remediation.
- Never execute suspicious hooks, scripts, binaries, or obfuscated code.
- Do not perform destructive cleanup or credential rotation without explicit authorization.
- Keep local security incident reports and sensitive client information out of the repository.

## Completion Report

At the end of each task, report concisely:

- What changed.
- Files changed.
- Tests/checks actually run and their results.
- Any unverified behavior, blockers, or risks.
- Which baseline documents were updated.
- The next recommended task, if useful.

Do not create a separate handoff document. Record durable progress in `docs/STATUS.md` and durable decisions in `docs/ARCHITECTURE.md`.
