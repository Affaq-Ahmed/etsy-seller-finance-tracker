import 'server-only';
import { z } from 'zod';

/** DEVELOPMENT.md §3: the auth secret must be at least 32 random bytes. */
export const MIN_AUTH_SECRET_LENGTH = 32;

const NODE_ENVS = ['development', 'production', 'test'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly databaseUrl: string;
  readonly auth: {
    readonly secret: string;
    /** Public origin of the application (scheme + host + optional port, no path). */
    readonly baseUrl: string;
  };
}

/** Lists offending variable names only; values are never included. */
export class ConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Invalid or missing environment variables: ${variables.join(', ')}`);
    this.name = 'ConfigError';
    this.variables = variables;
  }
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isPostgresUrl(value: string): boolean {
  const url = parseUrl(value);
  return url !== null && (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname !== '';
}

function isOriginUrl(value: string): boolean {
  const url = parseUrl(value);
  return url !== null
    && (url.protocol === 'http:' || url.protocol === 'https:')
    && url.username === '' && url.password === ''
    && url.pathname === '/' && url.search === '' && url.hash === '';
}

const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  DATABASE_URL: z.string().refine(isPostgresUrl),
  BETTER_AUTH_SECRET: z.string().min(MIN_AUTH_SECRET_LENGTH),
  BETTER_AUTH_URL: z.string().refine(isOriginUrl),
});

export function parseConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const names = new Set(result.error.issues.map((issue) => String(issue.path[0] ?? 'environment')));
    throw new ConfigError([...names].sort());
  }
  const values = result.data;
  const baseUrl = new URL(values.BETTER_AUTH_URL).origin;
  if (values.NODE_ENV === 'production' && !baseUrl.startsWith('https://')) {
    throw new ConfigError(['BETTER_AUTH_URL']);
  }
  return Object.freeze({
    nodeEnv: values.NODE_ENV,
    databaseUrl: values.DATABASE_URL,
    auth: Object.freeze({ secret: values.BETTER_AUTH_SECRET, baseUrl }),
  });
}

let cachedConfig: AppConfig | undefined;

/** Validated process configuration. Only the composition root should call this. */
export function getConfig(): AppConfig {
  cachedConfig ??= parseConfig(process.env);
  return cachedConfig;
}
