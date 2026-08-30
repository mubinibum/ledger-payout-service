import type { FastifyInstance } from 'fastify';
import { sendError } from '../../http/errors.js';
import type { WebhookService } from './webhooks.service.js';

/**
 * Inbound provider webhooks.
 *
 *   POST /v1/webhooks/provider/payouts
 *
 * Registered as its own plugin so the raw-body JSON parser below is scoped here only — the
 * rest of the API keeps Fastify's default parser. HMAC verification needs the exact bytes
 * the provider signed, so we keep the Buffer and parse it ourselves after the signature
 * check passes.
 */
export function webhookRoutes(deps: { webhooks: WebhookService }) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    app.post('/v1/webhooks/provider/payouts', async (request, reply) => {
      try {
        const rawBody = Buffer.isBuffer(request.body)
          ? request.body
          : Buffer.from(typeof request.body === 'string' ? request.body : '', 'utf8');

        const header = (name: string): string | undefined => {
          const v = request.headers[name];
          return Array.isArray(v) ? v[0] : v;
        };

        const outcome = await deps.webhooks.handle({
          rawBody,
          signatureHeader: header('x-provider-signature'),
          timestampHeader: header('x-provider-timestamp'),
          eventIdHeader: header('x-provider-event-id'),
        });
        return await reply.code(outcome.statusCode).send(outcome.body);
      } catch (err) {
        return sendError(request, reply, err);
      }
    });
  };
}
