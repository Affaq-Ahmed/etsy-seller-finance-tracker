const assert = require('node:assert/strict');
const fs = require('node:fs');
const postgres = require('postgres');
const { readMigrationFiles } = require('drizzle-orm/migrator');
const { validateLocalTestDatabase } = require('../tests/helpers/local-database.cjs');
(async () => {
  const url = validateLocalTestDatabase();
  const sql = postgres(url, { max: 1, onnotice() {} });
  try {
    const journal = JSON.parse(fs.readFileSync('drizzle/meta/_journal.json', 'utf8'));
    const latest = String(journal.entries.at(-1).idx).padStart(4, '0');
    const snapshot = JSON.parse(fs.readFileSync(`drizzle/meta/${latest}_snapshot.json`, 'utf8'));
    const [identity] = await sql`SELECT current_database() AS database, current_user AS role, current_setting('server_version') AS version`;
    assert.equal(identity.database, new URL(url).pathname.slice(1));
    const tables = await sql`SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`;
    assert.deepEqual(tables.map(t => t.name).sort(), Object.values(snapshot.tables).map(t => t.name).sort());
    const enums = await sql`SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'`;
    assert.deepEqual(enums.map(e => e.name).sort(), Object.values(snapshot.enums).map(e => e.name).sort());
    const fks = await sql`SELECT conname AS name FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND contype='f'`;
    const expectedFks = Object.values(snapshot.tables).flatMap(t => Object.values(t.foreignKeys).map(f => f.name));
    assert.deepEqual(fks.map(f => f.name).sort(), expectedFks.sort());
    const indexes = await sql`SELECT indexname AS name FROM pg_indexes WHERE schemaname='public'`;
    const expectedIndexes = Object.values(snapshot.tables).flatMap(t => [
      `${t.name}_pkey`, ...Object.values(t.indexes).map(i => i.name), ...Object.values(t.uniqueConstraints).map(u => u.name),
    ]);
    assert.deepEqual(indexes.map(i => i.name).sort(), expectedIndexes.sort());
    const source = journal.entries.map(e => fs.readFileSync(`drizzle/${e.tag}.sql`, 'utf8')).join('\n');
    const functionNames = [...new Set([...source.matchAll(/CREATE(?: OR REPLACE)? FUNCTION\s+(\w+)\(/g)].map(m => m[1]))];
    const functions = await sql`SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`;
    assert.deepEqual(functions.map(f => f.name).sort(), functionNames.sort());
    const expectedTriggers = [...new Set([...source.matchAll(/CREATE(?: CONSTRAINT)? TRIGGER\s+(\w+)\s+(?:BEFORE|AFTER)[\s\S]*?\bON\s+(\w+)/g)].map(m => `${m[2]}.${m[1]}`))];
    const triggers = await sql`SELECT c.relname || '.' || t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal`;
    assert.deepEqual(triggers.map(t => t.name).sort(), expectedTriggers.sort());
    const migrations = await sql`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
    const expectedMigrations = readMigrationFiles({ migrationsFolder: './drizzle' });
    assert.deepEqual(migrations.map(m => [m.hash, Number(m.created_at)]), expectedMigrations.map(m => [m.hash, m.folderMillis]));
    console.log(JSON.stringify({ ...identity, host: '127.0.0.1', tables: tables.length, enums: enums.length,
      foreignKeys: fks.length, indexes: indexes.length, functions: functions.length, triggers: triggers.length,
      migrations: migrations.length, migrationHashesAndOrdering: 'verified' }, null, 2));
  } finally { await sql.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
