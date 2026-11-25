// Generic, enumeration-safe messages. They never reveal whether an email is registered.

export const GENERIC_ERROR = 'Something went wrong. Please try again.';
export const TOO_MANY_ATTEMPTS = 'Too many attempts. Please wait a moment and try again.';
export const INVALID_CREDENTIALS = 'Invalid email or password.';
export const REGISTERED_NOTICE = 'If this email can be used, your account is ready. Sign in to continue.';

export function messageForStatus(status: number | undefined, fallback: string = GENERIC_ERROR): string {
  if (status === 429) return TOO_MANY_ATTEMPTS;
  return fallback;
}
