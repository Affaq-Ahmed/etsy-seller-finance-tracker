import 'server-only';
import { z } from 'zod';
import type { PageRequest } from '@/server/dal/tenant-scope';
import { validationError } from './errors';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 100_000;

const pageSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
});

/** Parses `?limit=&offset=`; other query keys are rejected so typos never silently widen a list. */
export function parsePageRequest(url: string): PageRequest {
  const query = Object.fromEntries(new URL(url).searchParams);
  const result = pageSchema.safeParse(query);
  if (!result.success) {
    throw validationError([...new Set(result.error.issues.flatMap((issue) => (issue.code === 'unrecognized_keys' ? issue.keys : issue.path.map(String))))].sort());
  }
  return result.data;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: { readonly limit: number; readonly offset: number; readonly total: number };
}

export function toPage<T>(items: readonly T[], request: PageRequest, total: number): Page<T> {
  return { items, page: { limit: request.limit, offset: request.offset, total } };
}
