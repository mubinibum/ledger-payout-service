import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Attaches a stable request id to every request (honouring an inbound `x-request-id`
 * when present) and echoes it on the response. The id is bound to the per-request
 * logger via Fastify's `genReqId`, so every log line for a request is correlated.
 */
export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done(null, payload);
  });
}

export function requestIdFactory(req: { headers: Record<string, unknown> }): string {
  const inbound = req.headers[REQUEST_ID_HEADER];
  if (typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 128) {
    return inbound;
  }
  return randomUUID();
}
