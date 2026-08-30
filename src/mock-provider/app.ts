import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { computeSignature } from '../domain/webhook-signature.js';
import { maybeFault } from '../infra/fault.js';

/**
 * A LOCAL-ONLY simulation of an external payout provider. It never touches the internet
 * and holds no real credentials. It is a completely separate app from the service — its
 * only shared code is the webhook signing helper, so the signatures it produces are the
 * ones the service verifies.
 *
 * Behaviour per payout is driven by a `scenario` set through the `_control` API (default:
 * immediate success), so tests are deterministic.
 */
type Scenario =
  | { mode: 'immediate_success' }
  | { mode: 'accept' } // accepted; resolves later via _control/complete or a webhook
  | { mode: 'accept_then_pending' } // GET keeps returning pending until _control/complete
  | { mode: 'permanent_rejection'; category?: string }
  | { mode: 'transient_5xx'; times: number }
  | { mode: 'rate_limit'; times: number }
  | { mode: 'timeout' } // never stores the payout, just hangs past the client timeout
  | { mode: 'ambiguous_timeout' }; // stores the payout, THEN hangs

type StoredState = 'accepted' | 'pending' | 'succeeded' | 'failed';
interface Stored {
  providerPayoutId: string;
  state: StoredState;
  amountMinor: string;
  currency: string;
  failureCategory?: string;
}

export interface MockProviderOptions {
  webhookUrl: string;
  webhookSecret: string;
  hangMs?: number;
}

export function buildMockProvider(opts: MockProviderOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const store = new Map<string, Stored>();
  const scenarios = new Map<string, Scenario>();
  const counters = new Map<string, number>();
  const hangMs = opts.hangMs ?? 5_000;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const scenarioFor = (key: string): Scenario =>
    scenarios.get(key) ?? { mode: 'immediate_success' };

  function wireFor(s: Stored): Record<string, unknown> {
    if (s.state === 'succeeded')
      return { status: 'succeeded', providerPayoutId: s.providerPayoutId };
    if (s.state === 'failed') {
      return {
        status: 'failed',
        providerPayoutId: s.providerPayoutId,
        failureCategory: s.failureCategory ?? 'permanent_rejection',
      };
    }
    if (s.state === 'pending') return { status: 'pending', providerPayoutId: s.providerPayoutId };
    return { status: 'accepted', providerPayoutId: s.providerPayoutId };
  }

  app.post('/payouts', async (request, reply) => {
    const body = request.body as {
      idempotencyKey: string;
      amountMinor: string;
      currency: string;
      reference: string | null;
    };
    const key = body.idempotencyKey;

    const existing = store.get(key);
    if (existing) return reply.send(wireFor(existing)); // idempotent replay

    const scenario = scenarioFor(key);
    const seen = (counters.get(key) ?? 0) + 1;
    counters.set(key, seen);

    switch (scenario.mode) {
      case 'transient_5xx':
        if (seen <= scenario.times)
          return reply.code(503).send({ error: 'temporarily unavailable' });
        break;
      case 'rate_limit':
        if (seen <= scenario.times) return reply.code(429).send({ error: 'rate limited' });
        break;
      case 'timeout':
        await sleep(hangMs);
        return reply.send({ status: 'accepted', providerPayoutId: 'late' });
      case 'permanent_rejection':
        return reply
          .code(422)
          .send({ failureCategory: scenario.category ?? 'permanent_rejection' });
      default:
        break;
    }

    const providerPayoutId = `mpp_${randomUUID()}`;
    const state: StoredState =
      scenario.mode === 'immediate_success'
        ? 'succeeded'
        : scenario.mode === 'accept_then_pending'
          ? 'pending'
          : 'accepted';
    const stored: Stored = {
      providerPayoutId,
      state,
      amountMinor: body.amountMinor,
      currency: body.currency,
    };
    store.set(key, stored);
    maybeFault('after_provider_accept');

    if (scenario.mode === 'ambiguous_timeout') {
      await sleep(hangMs);
      return reply.send(wireFor(stored));
    }

    return reply.send(wireFor(stored));
  });

  app.get('/payouts/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    const stored = store.get(key);
    if (!stored) return reply.code(404).send({ status: 'not_found' });
    return reply.send(wireFor(stored));
  });

  // ---- control plane (mock only) ----------------------------------------------

  app.post('/_control/scenario', async (request, reply) => {
    const { idempotencyKey, scenario } = request.body as {
      idempotencyKey: string;
      scenario: Scenario;
    };
    scenarios.set(idempotencyKey, scenario);
    return reply.send({ ok: true });
  });

  app.post('/_control/complete', async (request, reply) => {
    const { idempotencyKey, status, failureCategory } = request.body as {
      idempotencyKey: string;
      status: 'succeeded' | 'failed';
      failureCategory?: string;
    };
    const stored = store.get(idempotencyKey);
    if (!stored) return reply.code(404).send({ error: 'unknown payout' });
    stored.state = status;
    if (failureCategory) stored.failureCategory = failureCategory;
    return reply.send({ ok: true });
  });

  app.post('/_control/fire-webhook', async (request, reply) => {
    const body = request.body as {
      idempotencyKey: string;
      type: 'payout.succeeded' | 'payout.failed';
      eventId?: string;
      timestampSkewSec?: number;
      tamperSignature?: boolean;
      failureCategory?: string;
    };
    const stored = store.get(body.idempotencyKey);
    const eventId = body.eventId ?? `evt_${randomUUID()}`;
    const payload = JSON.stringify({
      eventId,
      type: body.type,
      providerPayoutId: stored?.providerPayoutId ?? null,
      idempotencyKey: body.idempotencyKey,
      failureCategory:
        body.type === 'payout.failed' ? (body.failureCategory ?? 'permanent_rejection') : undefined,
    });
    const ts = String(Math.floor(Date.now() / 1000) + (body.timestampSkewSec ?? 0));
    let signature = computeSignature(opts.webhookSecret, ts, payload);
    if (body.tamperSignature) signature = signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));

    const res = await fetch(opts.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-provider-timestamp': ts,
        'x-provider-signature': `sha256=${signature}`,
        'x-provider-event-id': eventId,
      },
      body: payload,
    });
    return reply.send({ delivered: res.status });
  });

  app.post('/_control/reset', async (_request, reply) => {
    store.clear();
    scenarios.clear();
    counters.clear();
    return reply.send({ ok: true });
  });

  return app;
}
