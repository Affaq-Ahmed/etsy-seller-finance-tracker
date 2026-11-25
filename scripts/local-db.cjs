const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateLocalTestDatabase } = require('../tests/helpers/local-database.cjs');
const stateFile = path.join(os.tmpdir(), `etsy-finance-local-db-${process.getuid()}.json`);
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw new Error(`Local Docker command failed: ${args[0]}`);
  return result.stdout.trim();
}
const action = process.argv[2];
if (action === 'start') {
  if (fs.existsSync(stateFile)) throw new Error('A test container state exists; stop it before starting another');
  const suffix = crypto.randomBytes(6).toString('hex');
  const name = `etsy-finance-test-${suffix}`, database = `etsy_finance_test_${suffix}`;
  const password = crypto.randomBytes(32).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-finance-test-'));
  const envFile = path.join(dir, 'container.env');
  fs.writeFileSync(envFile, `POSTGRES_USER=finance_test\nPOSTGRES_DB=${database}\nPOSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
  try {
    const id = docker(['run', '--detach', '--rm', '--name', name, '--label', 'etsy-finance.disposable=true',
      '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql', '--env-file', envFile, 'postgres:18']);
    const binding = docker(['port', id, '5432/tcp']);
    if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error('Container must bind only loopback');
    const port = binding.split(':')[1];
    fs.writeFileSync(stateFile, JSON.stringify({ id, name, dir, database, url: `postgresql://finance_test:${password}@127.0.0.1:${port}/${database}` }), { mode: 0o600 });
    console.log(`Disposable PostgreSQL created: ${name}; host 127.0.0.1; database ${database}; credentials retained only in protected temporary files.`);
  } finally { fs.rmSync(envFile, { force: true }); }
} else {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const info = JSON.parse(docker(['inspect', state.id]))[0];
  if (info.Config.Labels['etsy-finance.disposable'] !== 'true' || info.Name !== `/${state.name}`) throw new Error('Container identity mismatch');
  process.env.LOCAL_TEST_DATABASE_URL = state.url;
  process.env.LOCAL_TEST_DATABASE_DISPOSABLE = 'yes';
  validateLocalTestDatabase();
  if (action === 'ready') {
    docker(['exec', state.id, 'pg_isready', '-U', 'finance_test', '-d', state.database]);
    console.log('Dedicated local test PostgreSQL is accepting connections.');
  } else if (action === 'stop') {
    docker(['stop', state.id]);
    fs.rmSync(state.dir, { recursive: true, force: true }); fs.rmSync(stateFile);
    console.log('Disposable test container and temporary credentials removed.');
  } else if (action === 'run') {
    const args = process.argv.slice(3);
    if (!args.length) throw new Error('Specify a local test command');
    const env = { ...process.env }; delete env.DATABASE_URL;
    const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit', env });
    process.exitCode = result.status ?? 1;
  } else throw new Error('Use start, ready, run or stop');
}
