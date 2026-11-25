// Probe the real Drizzle config in isolated directories with synthetic values.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drizzle-env-audit-'));
const probe = `
  const fs = require('node:fs');
  const path = require('node:path');
  const Module = require('node:module');
  const ts = require('typescript');
  const filename = path.join(process.env.AUDIT_PROJECT_ROOT, 'drizzle.config.ts');
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText, filename);
  const url = m.exports.default.dbCredentials?.url;
  if (url !== process.env.AUDIT_EXPECTED_URL) process.exit(1);
`;
function run(expected, url) {
  const env = { ...process.env, NODE_ENV: 'development', AUDIT_PROJECT_ROOT: root, AUDIT_EXPECTED_URL: expected };
  delete env.DATABASE_URL;
  delete env.__NEXT_PROCESSED_ENV;
  if (url) env.DATABASE_URL = url;
  // Resolve installed modules from the project, not the temporary fixture.
  env.NODE_PATH = path.join(root, 'node_modules');
  const result = spawnSync(process.execPath, ['-e', probe], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `Environment precedence probe failed: ${result.stderr}`);
}
try {
  run(undefined);
  fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=base-synthetic-value\n');
  fs.writeFileSync(path.join(dir, '.env.local'), 'DATABASE_URL=local-synthetic-value\n');
  run('local-synthetic-value');
  run('shell-synthetic-value', 'shell-synthetic-value');
  console.log('Offline env audit passed: no-URL generation, .env.local precedence, shell precedence.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
