// Limits shared by server validation and browser forms (ARCHITECTURE.md §8).
// Server-side checks are authoritative; forms use these only for hints.

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
/** `business_accounts.shop_name` is varchar(160). */
export const SHOP_NAME_MAX_LENGTH = 160;
