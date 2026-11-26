import 'server-only';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './pagination';

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Page requests for server-rendered lists: `?offset=` only; anything unparsable is the first page. */
export async function pageFromSearchParams(searchParams: SearchParams): Promise<{ limit: number; offset: number }> {
  const raw = (await searchParams).offset;
  const parsed = typeof raw === 'string' && /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
  return { limit: Math.min(DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE), offset: parsed };
}
