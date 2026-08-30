import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type StartedMockProvider } from '../helpers/mock-provider.js';
import { MockProviderClient } from '../../src/modules/provider/mock-provider.client.js';
import { ProviderError } from '../../src/domain/provider-outcome.js';

/** The real HTTP mock-provider client against the real mock provider server. */
describe('integration: mock provider adapter', () => {
  let mock: StartedMockProvider;
  let client: MockProviderClient;

  beforeAll(async () => {
    mock = await startMockProvider({
      webhookUrl: 'http://127.0.0.1:59999/unused',
      webhookSecret: 'x'.repeat(20),
      hangMs: 400,
    });
    client = new MockProviderClient(mock.baseUrl, 150);
  });
  afterAll(() => mock.stop());
  beforeEach(() => mock.reset());

  const req = (
    key: string,
  ): { idempotencyKey: string; amountMinor: bigint; currency: string; reference: string } => ({
    idempotencyKey: key,
    amountMinor: 1000n,
    currency: 'USD',
    reference: key,
  });

  it('immediate success', async () => {
    const result = await client.createPayout(req('k1'));
    expect(result.kind).toBe('succeeded');
  });

  it('accepted then resolvable via getPayoutStatus', async () => {
    await mock.setScenario('k2', { mode: 'accept' });
    const created = await client.createPayout(req('k2'));
    expect(created.kind).toBe('accepted');

    await mock.complete('k2', 'succeeded');
    const status = await client.getPayoutStatus('k2');
    expect(status.kind).toBe('succeeded');
  });

  it('is idempotent — a duplicate createPayout returns the same provider payout id', async () => {
    await mock.setScenario('k3', { mode: 'accept' });
    const a = await client.createPayout(req('k3'));
    const b = await client.createPayout(req('k3'));
    expect(a.kind).toBe('accepted');
    expect(b.kind).toBe('accepted');
    expect(a.kind === 'accepted' && b.kind === 'accepted' && a.providerPayoutId).toBe(
      b.kind === 'accepted' && b.providerPayoutId,
    );
  });

  it('permanent rejection → ProviderError(permanent)', async () => {
    await mock.setScenario('k4', { mode: 'permanent_rejection', category: 'permanent_rejection' });
    await expect(client.createPayout(req('k4'))).rejects.toMatchObject({
      classification: 'permanent',
    });
  });

  it('transient 5xx → ProviderError(transient)', async () => {
    await mock.setScenario('k5', { mode: 'transient_5xx', times: 5 });
    await expect(client.createPayout(req('k5'))).rejects.toMatchObject({
      classification: 'transient',
    });
  });

  it('rate limit (429) → ProviderError(transient)', async () => {
    await mock.setScenario('k6', { mode: 'rate_limit', times: 5 });
    await expect(client.createPayout(req('k6'))).rejects.toMatchObject({
      classification: 'transient',
    });
  });

  it('timeout (never stored) → ProviderError(ambiguous)', async () => {
    await mock.setScenario('k7', { mode: 'timeout' });
    const err = await client.createPayout(req('k7')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).classification).toBe('ambiguous');
    // provider has no record of it
    expect((await client.getPayoutStatus('k7')).kind).toBe('unknown');
  });

  it('ambiguous timeout — provider DID store it, client sees ambiguous', async () => {
    await mock.setScenario('k8', { mode: 'ambiguous_timeout' });
    const err = await client.createPayout(req('k8')).catch((e: unknown) => e);
    expect((err as ProviderError).classification).toBe('ambiguous');
    // ...but a later status call finds it
    const status = await client.getPayoutStatus('k8');
    expect(status.kind === 'accepted' || status.kind === 'pending').toBe(true);
  });

  it('getPayoutStatus for an unknown key → unknown', async () => {
    expect((await client.getPayoutStatus('never-seen')).kind).toBe('unknown');
  });
});
