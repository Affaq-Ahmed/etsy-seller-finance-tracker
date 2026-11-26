import 'server-only';

export type DomainErrorKind = 'not_found' | 'conflict' | 'invalid_state' | 'unprocessable';

/**
 * A business-rule failure whose code, message and field names are safe to show
 * to clients. Never put values (amounts, notes, IDs of other tenants) in them.
 */
export class DomainError extends Error {
  readonly kind: DomainErrorKind;
  readonly code: string;
  /** Offending request field names only. */
  readonly fields: readonly string[] | undefined;

  constructor(kind: DomainErrorKind, code: string, message: string, fields?: readonly string[]) {
    super(message);
    this.name = 'DomainError';
    this.kind = kind;
    this.code = code;
    this.fields = fields;
  }
}

/** Another tenant's record and a missing record are indistinguishable by design. */
export const notFound = (what = 'Record') => new DomainError('not_found', 'NOT_FOUND', `${what} not found.`);
export const conflict = (code: string, message: string, fields?: readonly string[]) => new DomainError('conflict', code, message, fields);
export const invalidState = (code: string, message: string) => new DomainError('invalid_state', code, message);
export const unprocessable = (code: string, message: string, fields?: readonly string[]) => new DomainError('unprocessable', code, message, fields);
