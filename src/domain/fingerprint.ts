import { createHash } from 'node:crypto';

/**
 * Canonical request fingerprint for idempotency.
 *
 * Two requests are "the same" if their semantic fields are equal regardless of JSON key
 * order or insignificant formatting. We canonicalise the payload (recursively sorted keys,
 * no whitespace) and hash it with the scope. The stored `request_hash` lets a replay with
 * the same key be classified as: identical payload → return the first result; different
 * payload → 409 conflict.
 *
 * Only include fields that define the operation. Do NOT feed raw headers, timestamps, or
 * anything sensitive into this.
 */
export function requestFingerprint(scope: string, payload: unknown): string {
  return createHash('sha256')
    .update(`${scope}\n${canonicalJson(payload)}`)
    .digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
