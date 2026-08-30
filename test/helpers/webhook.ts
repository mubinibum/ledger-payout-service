import type { FastifyInstance } from 'fastify';
import { computeSignature } from '../../src/domain/webhook-signature.js';

const SECRET = 'test-webhook-secret-0123456789';

export interface WebhookOptions {
  eventId?: string;
  timestamp?: number;
  secret?: string;
  tamperBody?: boolean;
}

export async function postWebhook(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  opts: WebhookOptions = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const raw = JSON.stringify(payload);
  const bodyToSend = opts.tamperBody ? raw + ' ' : raw;
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = computeSignature(opts.secret ?? SECRET, ts, raw);
  const eventId = opts.eventId ?? (payload['eventId'] as string) ?? 'evt-default';

  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/provider/payouts',
    headers: {
      'content-type': 'application/json',
      'x-provider-timestamp': ts,
      'x-provider-signature': `sha256=${signature}`,
      'x-provider-event-id': eventId,
    },
    payload: bodyToSend,
  });
  return { statusCode: res.statusCode, body: res.json<Record<string, unknown>>() };
}
