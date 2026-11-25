import 'server-only';
import { getConfig, type AppConfig } from '@/server/config/env';
import { createDb, type Database } from '@/server/db/client';
import { createAuth, type Auth } from '@/server/auth/auth';

// Composition root: the only place that reads process configuration and wires
// factories together. Everything else receives its dependencies explicitly.

export interface AppContainer {
  readonly config: AppConfig;
  readonly db: Database;
  readonly auth: Auth;
  close(): Promise<void>;
}

export function createContainer(config: AppConfig): AppContainer {
  const { db, close } = createDb(config.databaseUrl);
  return { config, db, auth: createAuth({ db, config }), close };
}

// Node runtime: one container per server process, kept on globalThis so dev
// hot reloads do not leak connection pools. The Workers deployment adapter must
// instead build it per request, because sockets cannot be global there
// (ARCHITECTURE.md §2.1); that adapter is part of the deployment milestone.
const holder = globalThis as typeof globalThis & { __etsyFinanceContainer?: AppContainer };

export function getContainer(): AppContainer {
  holder.__etsyFinanceContainer ??= createContainer(getConfig());
  return holder.__etsyFinanceContainer;
}
