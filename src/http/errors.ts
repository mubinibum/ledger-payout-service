import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { DomainError, isDomainError } from '../domain/errors.js';

/**
 * One consistent error envelope for every failure:
 *
 *   { "error": { "code": "insufficient_funds", "message": "...", "details": {...} },
 *     "requestId": "..." }
 *
 * - Zod failures → 400 `validation_error` with the field issues.
 * - `DomainError` → its own `httpStatus` / `code`.
 * - Anything else → 500 `internal_error`, logged in full, but the client sees no detail.
 */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
  requestId: string;
}

export function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): FastifyReply {
  if (err instanceof ZodError) {
    return reply.code(400).send(
      body(request.id, 'validation_error', 'request failed validation', {
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }),
    );
  }

  if (isDomainError(err)) {
    if (err.httpStatus >= 500) {
      request.log.error({ err, code: err.code }, 'domain_error_5xx');
    } else {
      request.log.info({ code: err.code, status: err.httpStatus }, 'domain_error');
    }
    return reply.code(err.httpStatus).send(body(request.id, err.code, err.message, err.details));
  }

  request.log.error({ err }, 'unhandled_error');
  return reply.code(500).send(body(request.id, 'internal_error', 'internal error'));
}

function body(requestId: string, code: string, message: string, details?: unknown): ErrorBody {
  const envelope: ErrorBody = { error: { code, message }, requestId };
  if (details !== undefined) envelope.error.details = details;
  return envelope;
}

export { DomainError };
