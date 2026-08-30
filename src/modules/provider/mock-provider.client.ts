import { loadEnv } from '../../config/env.js';
import {
  ProviderError,
  classifyTransportError,
  type FailureCategory,
  type ProviderResult,
} from '../../domain/provider-outcome.js';
import type { CreatePayoutRequest, ProviderPort } from './provider.port.js';

/**
 * HTTP adapter for the local mock payout provider. Transport failures are classified
 * (`transient` vs `ambiguous`); explicit provider rejections become
 * `ProviderError('permanent')`. A timeout is treated as **ambiguous** — the provider may
 * have received the request — so the caller must not release funds on it.
 */
interface WireResult {
  status: 'accepted' | 'succeeded' | 'failed' | 'pending' | 'not_found';
  providerPayoutId?: string;
  failureCategory?: FailureCategory;
}

function toResult(wire: WireResult): ProviderResult {
  switch (wire.status) {
    case 'accepted':
      return { kind: 'accepted', providerPayoutId: wire.providerPayoutId ?? 'unknown' };
    case 'succeeded':
      return { kind: 'succeeded', providerPayoutId: wire.providerPayoutId ?? 'unknown' };
    case 'failed':
      return {
        kind: 'failed',
        providerPayoutId: wire.providerPayoutId ?? null,
        category: wire.failureCategory ?? 'permanent_rejection',
      };
    case 'pending':
      return { kind: 'pending', providerPayoutId: wire.providerPayoutId ?? null };
    case 'not_found':
      return { kind: 'unknown' };
  }
}

export class MockProviderClient implements ProviderPort {
  constructor(
    private readonly baseUrl = loadEnv().PROVIDER_BASE_URL,
    private readonly timeoutMs = loadEnv().PROVIDER_TIMEOUT_MS,
  ) {}

  async createPayout(req: CreatePayoutRequest): Promise<ProviderResult> {
    const wire = await this.request('POST', '/payouts', {
      idempotencyKey: req.idempotencyKey,
      amountMinor: req.amountMinor.toString(10),
      currency: req.currency,
      reference: req.reference,
    });
    return toResult(wire);
  }

  async getPayoutStatus(idempotencyKey: string): Promise<ProviderResult> {
    const wire = await this.request(
      'GET',
      `/payouts/${encodeURIComponent(idempotencyKey)}`,
      undefined,
    );
    return toResult(wire);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<WireResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError(
        classifyTransportError(err),
        `provider transport error: ${describe(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 || res.status >= 500) {
      throw new ProviderError('transient', `provider responded ${res.status}`);
    }
    if (res.status === 404 && method === 'GET') {
      return { status: 'not_found' };
    }
    if (res.status >= 400) {
      const payload = (await res.json().catch(() => ({}))) as { failureCategory?: FailureCategory };
      throw new ProviderError(
        'permanent',
        `provider rejected the payout (${res.status})`,
        payload.failureCategory ?? 'permanent_rejection',
      );
    }
    return (await res.json()) as WireResult;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.name;
  return 'unknown';
}
