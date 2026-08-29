import { ValidationError } from '../domain/errors.js';

/**
 * Opaque keyset cursor for deterministic pagination over an append-only, newest-first
 * list. The cursor carries the last row's `(created_at, id)` so the next page is
 * `WHERE (created_at, id) < (cursor.createdAt, cursor.id)` — stable even if rows are
 * inserted concurrently, and with no OFFSET scan.
 */
export interface Keyset {
  createdAt: string;
  id: string;
}

export function encodeCursor(keyset: Keyset): string {
  return Buffer.from(JSON.stringify(keyset), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Keyset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('invalid cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Keyset).createdAt !== 'string' ||
    typeof (parsed as Keyset).id !== 'string'
  ) {
    throw new ValidationError('invalid cursor');
  }
  const { createdAt, id } = parsed as Keyset;
  if (Number.isNaN(Date.parse(createdAt))) throw new ValidationError('invalid cursor');
  return { createdAt, id };
}
