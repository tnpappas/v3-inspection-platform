/**
 * PII masking utilities per security spec S11.
 *
 * Storage is unredacted; redaction happens at the API serialization layer
 * based on the requesting user's effective permissions. Users with the
 * permission `view.customer.pii` (or membership in a containing group such
 * as `customer_data`) bypass redaction; others receive masked strings.
 *
 * This module exports the redaction helpers. The actual application happens
 * in route handlers (or a future response transformer middleware) that calls
 * `maskPiiFields(record, fieldList, allowed)` before sending the response.
 */

const PII_GUARD_PERMISSION = 'view.customer.pii';

/**
 * Returns true if the user has permission to see unmasked PII.
 */
export function canSeePii(permissions: ReadonlySet<string>): boolean {
  return permissions.has(PII_GUARD_PERMISSION);
}

/**
 * Mask an email like `j****@example.com`. Preserves first character and domain.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (email == null) return null;
  const at = email.indexOf('@');
  if (at <= 0) return '****';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const first = local[0] ?? '*';
  return `${first}****${domain}`;
}

/**
 * Mask a phone like `***-***-1234`. Preserves last 4 digits.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (phone == null) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  const last4 = digits.slice(-4);
  return `***-***-${last4}`;
}

/**
 * Mask a street address like `*** Main St`. City / state / zip are not PII
 * alone and are returned verbatim by the caller.
 */
export function maskAddress(address1: string | null | undefined): string | null {
  if (address1 == null) return null;
  // Replace house number (leading digits) with stars; keep street name.
  const match = address1.match(/^(\d+)\s+(.+)$/);
  if (match) return `*** ${match[2] ?? ''}`.trim();
  // No leading number; redact entirely.
  return '***';
}

/**
 * Mask a government id (license number, SSN-like) entirely.
 */
export function maskGovernmentId(value: string | null | undefined): string | null {
  if (value == null) return null;
  return '***-***-****';
}

/**
 * Free-text notes can contain unstructured PII. Redact entirely.
 */
export function maskNotes(value: string | null | undefined): string | null {
  if (value == null) return null;
  return '[redacted]';
}

/**
 * Permission-aware wrapper: returns the value if allowed, else a mask.
 */
export function maybeMask<T extends string | null | undefined>(
  value: T,
  allowed: boolean,
  mask: (v: T) => string | null,
): T | string | null {
  if (allowed) return value;
  return mask(value);
}
