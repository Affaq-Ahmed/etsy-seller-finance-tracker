import 'server-only';
import { notFound } from 'next/navigation';
import { DomainError } from '@/server/domain/errors';

/** Renders the not-found page for a missing (or other tenant's) record instead of an error page. */
export async function orNotFound<T>(load: Promise<T>): Promise<T> {
  try {
    return await load;
  } catch (error) {
    if (error instanceof DomainError && error.kind === 'not_found') notFound();
    throw error;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed ID is a missing record. */
export function assertUuidOrNotFound(value: string): string {
  if (!UUID_PATTERN.test(value)) notFound();
  return value;
}
