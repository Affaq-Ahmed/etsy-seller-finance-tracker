import 'server-only';
import {
  getPostgresErrorCode,
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_RAISE_EXCEPTION,
  PG_UNIQUE_VIOLATION,
} from '@/server/db/errors';
import { DomainError, type DomainErrorKind } from '@/server/domain/errors';
import { jsonResponse } from './responses';

const DOMAIN_STATUS: Record<DomainErrorKind, number> = {
  not_found: 404,
  conflict: 409,
  invalid_state: 409,
  unprocessable: 422,
};

/** An error whose status, code and message are safe to return to clients. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;
  /** Offending field names only; never values. */
  readonly fields: readonly string[] | undefined;

  constructor(status: number, code: string, publicMessage: string, fields?: readonly string[]) {
    super(publicMessage);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
    this.fields = fields;
  }
}

export const unauthenticatedError = () => new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
export const onboardingRequiredError = () => new HttpError(409, 'ONBOARDING_REQUIRED', 'Create your business before continuing.');
/** Used both for missing records and for records owned by another tenant. */
export const notFoundError = () => new HttpError(404, 'NOT_FOUND', 'Not found.');
export const forbiddenOriginError = () => new HttpError(403, 'FORBIDDEN_ORIGIN', 'Request origin is not allowed.');
export const unsupportedMediaTypeError = () => new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json.');
export const payloadTooLargeError = () => new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
export const invalidJsonError = () => new HttpError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
export const validationError = (fields: readonly string[]) => new HttpError(400, 'INVALID_REQUEST', 'The request is invalid.', fields);

/**
 * Maps any thrown value to a generic client response. SQL, parameters, stack
 * traces and internal messages are never included (ARCHITECTURE.md §5).
 */
export function errorToResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ error: { code: error.code, message: error.publicMessage, ...(error.fields ? { fields: error.fields } : {}) } }, error.status);
  }
  if (error instanceof DomainError) {
    return jsonResponse({ error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } }, DOMAIN_STATUS[error.kind]);
  }
  const code = getPostgresErrorCode(error);
  if (code === PG_UNIQUE_VIOLATION) {
    return jsonResponse({ error: { code: 'CONFLICT', message: 'The request conflicts with existing data.' } }, 409);
  }
  if (code === PG_FOREIGN_KEY_VIOLATION || code === PG_CHECK_VIOLATION || code === PG_RAISE_EXCEPTION) {
    return jsonResponse({ error: { code: 'UNPROCESSABLE', message: 'The request could not be processed.' } }, 422);
  }
  console.error('[api] unexpected error', { name: error instanceof Error ? error.name : typeof error, code: code ?? null });
  return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } }, 500);
}
