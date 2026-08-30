import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Inbound provider webhook signing scheme (generic, invented for this project):
 *
 *   signed_payload = `${timestamp}.${rawBody}`
 *   signature      = hex( HMAC-SHA256(secret, signed_payload) )
 *
 * sent as headers:
 *   x-provider-timestamp: <unix seconds>
 *   x-provider-signature: sha256=<hex>
 *   x-provider-event-id:  <opaque unique id>
 *
 * Verification uses the **raw** request body (not a re-serialised object), a constant-time
 * comparison, and a bounded clock-skew window.
 */
export interface WebhookVerifyInput {
  rawBody: Buffer | string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  secret: string;
  toleranceSeconds: number;
  nowSeconds?: number;
}

export type WebhookVerifyResult =
  { ok: true } | { ok: false; reason: 'malformed' | 'timestamp' | 'signature' };

export function computeSignature(
  secret: string,
  timestamp: string,
  rawBody: Buffer | string,
): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

export function verifyWebhook(input: WebhookVerifyInput): WebhookVerifyResult {
  const { rawBody, signatureHeader, timestampHeader, secret, toleranceSeconds } = input;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!signatureHeader || !timestampHeader) return { ok: false, reason: 'malformed' };

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) return { ok: false, reason: 'malformed' };
  if (Math.abs(now - ts) > toleranceSeconds) return { ok: false, reason: 'timestamp' };

  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  if (!/^[0-9a-f]{64}$/i.test(provided)) return { ok: false, reason: 'malformed' };

  const expected = computeSignature(secret, timestampHeader, rawBody);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'signature' };

  return { ok: true };
}
