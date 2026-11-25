import { describe, expect, it } from 'vitest';
import { ConfigError, MIN_AUTH_SECRET_LENGTH, parseConfig } from '@/server/config/env';

const SECRET = 'x'.repeat(MIN_AUTH_SECRET_LENGTH);
const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://app:synthetic@127.0.0.1:5432/etsy_finance_dev',
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: 'http://localhost:3000/',
};

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected ConfigError');
}

describe('environment configuration', () => {
  it('parses a valid environment and normalizes the base URL to an origin', () => {
    const config = parseConfig(valid);
    expect(config).toEqual({
      nodeEnv: 'development',
      databaseUrl: valid.DATABASE_URL,
      auth: { secret: SECRET, baseUrl: 'http://localhost:3000' },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.auth)).toBe(true);
  });

  it('defaults NODE_ENV to development', () => {
    expect(parseConfig({ ...valid, NODE_ENV: undefined }).nodeEnv).toBe('development');
  });

  it('fails closed listing every missing variable by name', () => {
    const error = configError({});
    expect(error.variables).toEqual(['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'DATABASE_URL']);
    expect(error.message).toContain('BETTER_AUTH_SECRET');
  });

  it('rejects a short secret without echoing it', () => {
    const shortSecret = 'too-short-synthetic-secret';
    const error = configError({ ...valid, BETTER_AUTH_SECRET: shortSecret });
    expect(error.variables).toEqual(['BETTER_AUTH_SECRET']);
    expect(error.message).not.toContain(shortSecret);
  });

  it.each([
    ['mysql://u:p@127.0.0.1/db'],
    ['not a url'],
    [''],
  ])('rejects a non-PostgreSQL DATABASE_URL (%s) without echoing it', (url) => {
    const error = configError({ ...valid, DATABASE_URL: url });
    expect(error.variables).toEqual(['DATABASE_URL']);
    if (url) expect(error.message).not.toContain(url);
  });

  it.each([
    ['http://localhost:3000/app'],
    ['http://localhost:3000/?x=1'],
    ['http://user:pass@localhost:3000'],
    ['ftp://localhost'],
    ['localhost:3000'],
  ])('rejects BETTER_AUTH_URL that is not a bare origin: %s', (url) => {
    expect(configError({ ...valid, BETTER_AUTH_URL: url }).variables).toEqual(['BETTER_AUTH_URL']);
  });

  it('requires https in production', () => {
    expect(configError({ ...valid, NODE_ENV: 'production' }).variables).toEqual(['BETTER_AUTH_URL']);
    expect(parseConfig({ ...valid, NODE_ENV: 'production', BETTER_AUTH_URL: 'https://app.example.test' }).auth.baseUrl).toBe('https://app.example.test');
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(configError({ ...valid, NODE_ENV: 'staging' }).variables).toEqual(['NODE_ENV']);
  });
});
