// Postgres error inspection without exposing error messages. drizzle-orm wraps
// driver errors in DrizzleQueryError whose message embeds the SQL *and its
// parameters*, so callers must never log or return `error.message`.

const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 5;

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';
export const PG_RAISE_EXCEPTION = 'P0001';
export const PG_SERIALIZATION_FAILURE = '40001';
export const PG_DEADLOCK_DETECTED = '40P01';

/** Name of the violated constraint (`constraint_name`) of a Postgres error, if the driver reports one. */
export function getPostgresConstraintName(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current; depth++) {
    if (typeof current !== 'object') return undefined;
    const name = (current as { constraint_name?: unknown }).constraint_name;
    if (typeof name === 'string' && name.length > 0) return name;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Returns the SQLSTATE of a Postgres error, following wrapper `cause` chains. */
export function getPostgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current; depth++) {
    if (typeof current !== 'object') return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && SQLSTATE.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
