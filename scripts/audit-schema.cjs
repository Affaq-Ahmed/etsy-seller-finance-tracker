// Offline structural regression checks. Never creates a PostgreSQL client.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { getTableConfig } = require('drizzle-orm/pg-core');
const { is, Table } = require('drizzle-orm');
const filename = path.resolve('src/db/schema.ts');
const schemaModule = new Module(filename, module);
schemaModule.filename = filename;
schemaModule.paths = Module._nodeModulePaths(path.dirname(filename));
schemaModule._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);
const tables = Object.values(schemaModule.exports).filter(value => is(value, Table));
const configs = tables.map(getTableConfig);
const journal = JSON.parse(fs.readFileSync('drizzle/meta/_journal.json', 'utf8'));
const initialSql = journal.entries.map(e => fs.readFileSync(`drizzle/${e.tag}.sql`, 'utf8')).join('\n');
let foreignKeyCount = 0;
for (const config of configs) {
  const names = [config.name, ...config.indexes.map(i => i.config.name), ...config.checks.map(c => c.name)];
  for (const name of names) assert(Buffer.byteLength(name) <= 63, `Postgres identifier truncation: ${name}`);
  const tenant = config.columns.find(c => c.name === 'account_id');
  if (!['user', 'session', 'account', 'verification', 'business_accounts'].includes(config.name)) {
    assert(tenant?.notNull, `${config.name} must have a non-null tenant`);
    assert(config.foreignKeys.some(fk => {
      const r = fk.reference();
      return r.columns.length === 1 && r.columns[0] === tenant && getTableConfig(r.foreignTable).name === 'business_accounts';
    }), `${config.name} must reference tenant root`);
  }
  for (const fk of config.foreignKeys) {
    foreignKeyCount++;
    const r = fk.reference();
    const target = getTableConfig(r.foreignTable);
    const targetNames = r.foreignColumns.map(c => c.name).sort().join(',');
    const uniqueKeys = [
      target.columns.filter(c => c.primary),
      ...target.uniqueConstraints.map(u => u.columns),
      ...target.indexes.filter(i => i.config.unique && !i.config.where).map(i => i.config.columns),
    ];
    assert(uniqueKeys.some(cols => cols.map(c => c.name).sort().join(',') === targetNames),
      `${config.name}.${fk.getName()} has no exact nonpartial unique target`);
    // Kit 0.30 emits unique indexes after foreign keys in initial migrations.
    // Every referenced key must therefore be a PK or table UNIQUE constraint.
    assert([target.columns.filter(c => c.primary), ...target.uniqueConstraints.map(u => u.columns)]
      .some(cols => cols.map(c => c.name).sort().join(',') === targetNames),
      `${fk.getName()} depends on an index emitted too late by Kit`);
    const fkPosition = initialSql.indexOf(`ADD CONSTRAINT "${fk.getName()}" FOREIGN KEY`);
    assert(fkPosition > initialSql.indexOf(`CREATE TABLE "${target.name}"`),
      `${fk.getName()} must follow its target table`);
    assert(Buffer.byteLength(fk.getName()) <= 63, `FK identifier too long: ${fk.getName()}`);
    if (target.columns.some(c => c.name === 'account_id') && config.name !== 'account') {
      assert(r.columns.some(c => c.name === 'account_id'), `${fk.getName()} omits tenant`);
    }
  }
}
const sql = fs.readFileSync('src/db/sql/financial-integrity.sql', 'utf8');
const baseline = fs.readFileSync('drizzle/0001_financial_integrity.sql', 'utf8');
const hardening = fs.readFileSync('src/db/sql/financial-hardening.sql', 'utf8');
const financialFollowup = fs.readFileSync('src/db/sql/financial-followup.sql', 'utf8');
const shipmentFollowup = fs.readFileSync('src/db/sql/shipment-followup.sql', 'utf8');
const allocationValidation = fs.readFileSync('src/db/sql/allocation-validation.sql', 'utf8');
assert.equal(allocationValidation, fs.readFileSync('drizzle/0008_deposit_reconciliation_capacity.sql', 'utf8'));
assert.equal(sql, baseline + '\n' + hardening + '\n' + financialFollowup + '\n' + allocationValidation, 'Cumulative financial source must match migration history');
assert.equal(hardening, fs.readFileSync('drizzle/0005_financial_posting_hardening.sql', 'utf8'));
assert.equal(fs.readFileSync('src/db/sql/shipment-integrity.sql', 'utf8'), fs.readFileSync('drizzle/0006_shipment_history_integrity.sql', 'utf8') + '\n' + shipmentFollowup);
assert.equal(fs.readFileSync('drizzle/0007_integrity_followup.sql', 'utf8'), financialFollowup + '\n--> statement-breakpoint\n' + shipmentFollowup);
const crypto = require('node:crypto');
for (const [file, hash] of Object.entries(JSON.parse(fs.readFileSync('tests/baseline-migrations.json', 'utf8')))) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, `Historical migration changed: ${file}`);
}
for (const fragment of ['journal_entry_immutable', 'journal_line_immutable', 'DEFERRABLE INITIALLY DEFERRED',
  'supplier_confirmation_valid', 'validate_financial_allocations', 'guard_posted_source']) assert(sql.includes(fragment));
console.log(`Offline audit passed: ${configs.length} tables, ${foreignKeyCount} valid FK targets, tenant roots, identifier lengths, custom migration parity.`);
