import { loadEnv } from '../../config/env.js';
import {
  CONSERVATIVE_CAPABILITIES,
  ProviderError,
  classifyTransportError,
  type FailureCategory,
  type ProviderCapabilities,
  type ProviderResult,
} from '../../domain/provider-outcome.js';
import type { CreatePayoutRequest, ProviderPort } from './provider.port.js';

/**
 * HTTP adapter for the local mock payout provider.
 *
 * Classification is CONSERVATIVE by default:
 *  - connection refused / DNS  → transient  (proven the request never landed)
 *  - timeout / reset / unknown → ambiguous  (the provider MAY have received it → no release)
 *  - HTTP 5xx                  → ambiguous  (unless `fivexxIsDefinitiveNonProcessing`)
 *  - HTTP 429                  → transient  (rate-limited before processing)
 *  - an explicit 4xx body      → ProviderError('permanent') — a definitive rejection
 *  - unparseable success body  → ambiguous
 *  - GET 404 (not_found)       → `unknown`  (ambiguity resolved by `notFoundIsDefinitive`)
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

export interface MockProviderClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  capabilities?: Partial<ProviderCapabilities>;
}

export class MockProviderClient implements ProviderPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly caps: ProviderCapabilities;

  constructor(opts: MockProviderClientOptions = {}) {
    const env = loadEnv();
    this.baseUrl = opts.baseUrl ?? env.PROVIDER_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? env.PROVIDER_TIMEOUT_MS;
    this.caps = { ...CONSERVATIVE_CAPABILITIES, ...opts.capabilities };
  }

  capabilities(): ProviderCapabilities {
    return this.caps;
  }

  async createPayout(req: CreatePayoutRequest): Promise<ProviderResult> {
    return toResult(
      await this.request('POST', '/payouts', {
        idempotencyKey: req.idempotencyKey,
        amountMinor: req.amountMinor.toString(10),
        currency: req.currency,
        reference: req.reference,
      }),
    );
  }

  async getPayoutStatus(idempotencyKey: string): Promise<ProviderResult> {
    return toResult(
      await this.request('GET', `/payouts/${encodeURIComponent(idempotencyKey)}`, undefined),
    );
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

    if (res.status === 429) {
      throw new ProviderError('transient', 'provider responded 429');
    }
    if (res.status >= 500) {
      throw new ProviderError(
        this.caps.fivexxIsDefinitiveNonProcessing ? 'transient' : 'ambiguous',
        `provider responded ${res.status}`,
      );
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

    try {
      const parsed = (await res.json()) as WireResult;
      if (!parsed || typeof parsed.status !== 'string') {
        throw new Error('missing status');
      }
      return parsed;
    } catch {
      // A 2xx we cannot parse — the provider may have acted; treat as ambiguous.
      throw new ProviderError('ambiguous', 'provider returned an unparseable response');
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.name;
  return 'unknown';
}
