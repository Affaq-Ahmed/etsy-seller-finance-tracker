const assert = require('node:assert/strict');

// Never read DATABASE_URL or load an application environment file.
function validateLocalTestDatabase(url = process.env.LOCAL_TEST_DATABASE_URL) {
  assert(url, 'LOCAL_TEST_DATABASE_URL is required');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid local test database URL'); }
  assert(['postgres:', 'postgresql:'].includes(parsed.protocol), 'PostgreSQL URL required');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'Only local PostgreSQL is allowed');
  assert(/^\/etsy_finance_test_[a-z0-9_]+$/.test(parsed.pathname), 'Use a dedicated etsy_finance_test_* database');
  assert.equal(parsed.search, '', 'Connection override query parameters are forbidden');
  assert.equal(parsed.hash, '', 'Connection URL fragments are forbidden');
  assert.equal(process.env.LOCAL_TEST_DATABASE_DISPOSABLE, 'yes', 'Explicitly mark the configured database disposable');
  return url;
}
module.exports = { validateLocalTestDatabase };
