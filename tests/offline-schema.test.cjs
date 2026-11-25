const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { getTableConfig } = require('drizzle-orm/pg-core');
function load(filename) {
  const target=path.resolve(filename), m=new Module(target,module);
  m.filename=target; m.paths=Module._nodeModulePaths(path.dirname(target));
  m._compile(ts.transpileModule(fs.readFileSync(target,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,target);
  return m.exports;
}
const schema=load('src/db/schema.ts');
test('migration chain has valid tenant/unique targets, ordering and frozen historical migrations',()=>{
  const result=spawnSync(process.execPath,['scripts/audit-schema.cjs'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr || result.stdout);
});
test('Next environment precedence and credential-free generation',()=>{
  const result=spawnSync(process.execPath,['scripts/audit-env.cjs'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr || result.stdout);
});
test('Better Auth 1.6.3 verified field manifest matches current Drizzle models',()=>{
  const manifest=require('./fixtures/better-auth-1.6.3.json');
  const models={user:schema.users,session:schema.sessions,account:schema.authAccounts,verification:schema.verifications};
  for(const [model,fields] of Object.entries(manifest.tables)) {
    const table=models[model]; assert(table,`Missing auth model ${model}`);
    const config=getTableConfig(table);
    for(const [field,expected] of Object.entries(fields)) {
      const actual=table[field]; assert(actual,`Missing ${model}.${field}`);
      if(expected.required) assert(actual.notNull || actual.primary,`${model}.${field} must be required`);
      assert.equal(actual.dataType, {string:'string',boolean:'boolean',date:'date',number:'number'}[expected.type],`${model}.${field} type`);
      if(expected.unique) assert(actual.primary || actual.isUnique || config.indexes.some(i=>i.config.unique && i.config.columns.length===1 && i.config.columns[0].name===actual.name),`${model}.${field} unique`);
    }
  }
});
test('shipment ownership FKs are restrictive and preserve multiple shipments per order',()=>{
  const shipment=getTableConfig(schema.shipments),events=getTableConfig(schema.shipmentEvents);
  for(const config of [shipment,events]) assert(config.foreignKeys.every(f=>f.onDelete==='restrict'));
  assert(!shipment.uniqueConstraints.some(u=>u.columns.includes(schema.shipments.orderId)));
  assert(!shipment.indexes.some(i=>i.config.unique && i.config.columns.includes(schema.shipments.orderId)));
});
test('reversal references include tenant and currency and reserve one reversal per original',()=>{
  const config=getTableConfig(schema.journalEntries);
  const fk=config.foreignKeys.find(f=>f.getName()==='journal_reversal_original_tenant_currency_fk');
  assert.deepEqual(fk.reference().columns.map(c=>c.name),['account_id','reversal_of_entry_id','currency']);
  assert(config.indexes.some(i=>i.config.name==='journal_reversal_original_uq' && i.config.unique));
});
test('declared posting legs use exact decimals and tenant/currency foreign keys',()=>{
  const config=getTableConfig(schema.financialPostingLegs);
  assert.equal(schema.financialPostingLegs.debitAmount.getSQLType(),'numeric(19, 4)');
  assert.equal(schema.financialPostingLegs.creditAmount.getSQLType(),'numeric(19, 4)');
  for(const fk of config.foreignKeys.filter(f=>f.reference().columns.length>1)) assert.deepEqual(fk.reference().columns.map(c=>c.name).filter(n=>['account_id','currency'].includes(n)),['account_id','currency']);
});

test('local database safety rejects remote hosts, retained databases and URL overrides',()=>{
  const {validateLocalTestDatabase}=require('./helpers/local-database.cjs');
  const old=process.env.LOCAL_TEST_DATABASE_DISPOSABLE;
  process.env.LOCAL_TEST_DATABASE_DISPOSABLE='yes';
  try {
    assert.throws(()=>validateLocalTestDatabase('postgresql://test:synthetic@remote.example/etsy_finance_test_case'),/Only local/);
    assert.throws(()=>validateLocalTestDatabase('postgresql://test:synthetic@127.0.0.1/development'),/dedicated/);
    assert.throws(()=>validateLocalTestDatabase('postgresql://test:synthetic@127.0.0.1/etsy_finance_test_case?host=remote.example'),/override/);
    assert.throws(()=>validateLocalTestDatabase('postgresql://test:synthetic@127.0.0.1/etsy_finance_test_case#override'),/fragments/);
    process.env.LOCAL_TEST_DATABASE_DISPOSABLE='no';
    assert.throws(()=>validateLocalTestDatabase('postgresql://test:synthetic@127.0.0.1/etsy_finance_test_case'),/disposable/);
  } finally {
    if(old===undefined)delete process.env.LOCAL_TEST_DATABASE_DISPOSABLE;else process.env.LOCAL_TEST_DATABASE_DISPOSABLE=old;
  }
});
test('local migration config cannot load application environment files',()=>{
  const filename=path.resolve('drizzle.local-test.config.ts');
  const config=new Module(filename,module);config.filename=filename;config.paths=Module._nodeModulePaths(path.dirname(filename));
  const oldUrl=process.env.LOCAL_TEST_DATABASE_URL,oldMarker=process.env.LOCAL_TEST_DATABASE_DISPOSABLE;
  process.env.LOCAL_TEST_DATABASE_URL='postgresql://test:synthetic@127.0.0.1/etsy_finance_test_offline';
  process.env.LOCAL_TEST_DATABASE_DISPOSABLE='yes';
  const reads=[],originalRead=fs.readFileSync;
  try {
    const code=ts.transpileModule(originalRead(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
    fs.readFileSync=function(file,...args){reads.push(String(file));return originalRead.call(this,file,...args);};
    config._compile(code,filename);
    assert.equal(config.exports.default.dbCredentials.url,process.env.LOCAL_TEST_DATABASE_URL);
    assert(!reads.some(f=>/\/\.env(?:\.|$)/.test(f)),'Local config must not read application .env files');
  } finally {
    fs.readFileSync=originalRead;
    if(oldUrl===undefined)delete process.env.LOCAL_TEST_DATABASE_URL;else process.env.LOCAL_TEST_DATABASE_URL=oldUrl;
    if(oldMarker===undefined)delete process.env.LOCAL_TEST_DATABASE_DISPOSABLE;else process.env.LOCAL_TEST_DATABASE_DISPOSABLE=oldMarker;
  }
});
