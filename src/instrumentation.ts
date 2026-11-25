import { PHASE_PRODUCTION_BUILD } from 'next/constants';

/**
 * Startup validation (AGENTS.md "No Hardcoding"): a Node server refuses to
 * start with missing or invalid environment variables. Skipped during
 * `next build`, which needs no runtime secrets.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return;
  const { getConfig } = await import('./server/config/env');
  getConfig();
}
