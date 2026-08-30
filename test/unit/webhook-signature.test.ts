import { describe, expect, it } from 'vitest';
import { computeSignature, verifyWebhook } from '../../src/domain/webhook-signature.js';

const SECRET = 'a-sufficiently-long-test-secret-value';
const now = 1_760_000_000;

function sign(body: string, ts = now): { sig: string; ts: string } {
  const tsStr = String(ts);
  return { sig: `sha256=${computeSignature(SECRET, tsStr, body)}`, ts: tsStr };
}

describe('webhook signature verification', () => {
  const body = JSON.stringify({ eventId: 'evt_1', type: 'payout.succeeded' });

  it('accepts a correctly signed, fresh request', () => {
    const { sig, ts } = sign(body);
    expect(
      verifyWebhook({
        rawBody: Buffer.from(body),
        signatureHeader: sig,
        timestampHeader: ts,
        secret: SECRET,
        toleranceSeconds: 300,
        nowSeconds: now,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const { sig, ts } = sign(body);
    const result = verifyWebhook({
      rawBody: Buffer.from(body + ' '),
      signatureHeader: sig,
      timestampHeader: ts,
      secret: SECRET,
      toleranceSeconds: 300,
      nowSeconds: now,
    });
    expect(result).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects a wrong secret', () => {
    const { sig, ts } = sign(body);
    expect(
      verifyWebhook({
        rawBody: Buffer.from(body),
        signatureHeader: sig,
        timestampHeader: ts,
        secret: 'different-secret-of-enough-length',
        toleranceSeconds: 300,
        nowSeconds: now,
      }).ok,
    ).toBe(false);
  });

  it('rejects a stale timestamp', () => {
    const { sig, ts } = sign(body, now - 3600);
    expect(
      verifyWebhook({
        rawBody: Buffer.from(body),
        signatureHeader: sig,
        timestampHeader: ts,
        secret: SECRET,
        toleranceSeconds: 300,
        nowSeconds: now,
      }),
    ).toEqual({ ok: false, reason: 'timestamp' });
  });

  it('rejects a future timestamp beyond tolerance', () => {
    const { sig, ts } = sign(body, now + 3600);
    expect(
      verifyWebhook({
        rawBody: Buffer.from(body),
        signatureHeader: sig,
        timestampHeader: ts,
        secret: SECRET,
        toleranceSeconds: 300,
        nowSeconds: now,
      }),
    ).toEqual({ ok: false, reason: 'timestamp' });
  });

  it('rejects missing headers as malformed', () => {
    expect(
      verifyWebhook({
        rawBody: Buffer.from(body),
        signatureHeader: undefined,
        timestampHeader: String(now),
        secret: SECRET,
        toleranceSeconds: 300,
        nowSeconds: now,
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a non-hex signature as malformed', () => {
    expect(
      verifyWebhook({
        rawBody: Buffer.from(body),
        signatureHeader: 'sha256=not-hex',
        timestampHeader: String(now),
        secret: SECRET,
        toleranceSeconds: 300,
        nowSeconds: now,
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('is stable — same inputs, same signature', () => {
    expect(computeSignature(SECRET, String(now), body)).toBe(
      computeSignature(SECRET, String(now), body),
    );
  });
});
