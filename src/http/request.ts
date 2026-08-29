import type { FastifyRequest } from 'fastify';
import { IdempotencyKeyRequiredError, ValidationError } from '../domain/errors.js';
import { parseMinorUnits } from '../domain/money.js';

/** Reads and validates the `Idempotency-Key` header (required, bounded length). */
export function requireIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IdempotencyKeyRequiredError();
  }
  if (value.length > 200) {
    throw new ValidationError('Idempotency-Key must be at most 200 characters');
  }
  return value.trim();
}

/** Turns a validated JSON amount (string|number) into `bigint`, mapping bounds to 400. */
export function parseAmount(input: string | number): bigint {
  try {
    return parseMinorUnits(input);
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : 'invalid amount');
  }
}
