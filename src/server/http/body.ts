import 'server-only';
import type { z } from 'zod';
import { invalidJsonError, payloadTooLargeError, unsupportedMediaTypeError, validationError } from './errors';

/** Upper bound for JSON request bodies on this app's API routes. */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

function issueFields(error: z.ZodError): string[] {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') for (const key of issue.keys) fields.add(key);
    else fields.add(issue.path.length ? issue.path.map(String).join('.') : '(body)');
  }
  return [...fields].sort();
}

/** Parses a JSON body with a strict schema. Errors name fields, never echo values. */
export async function readJsonBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(contentType.trim())) throw unsupportedMediaTypeError();
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_JSON_BODY_BYTES) throw payloadTooLargeError();
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) throw payloadTooLargeError();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalidJsonError();
  }
  const result = schema.safeParse(data);
  if (!result.success) throw validationError(issueFields(result.error));
  return result.data;
}
