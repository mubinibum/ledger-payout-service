import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';

/** Thin helpers over `app.inject` for the account/transfer flows used across tests. */

export interface AccountResponse {
  id: string;
  externalId: string;
  currency: string;
  status: string;
  allowOverdraft: boolean;
  balanceMinor: string;
}

export async function createAccount(
  app: FastifyInstance,
  overrides: Partial<{ externalId: string; currency: string; allowOverdraft: boolean }> = {},
): Promise<AccountResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    payload: {
      externalId: overrides.externalId ?? `acct-${randomUUID()}`,
      currency: overrides.currency ?? 'USD',
      allowOverdraft: overrides.allowOverdraft ?? false,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ account: AccountResponse }>().account;
}

export async function fundAccount(
  app: FastifyInstance,
  accountId: string,
  amount: string | number,
  opts: { currency?: string; idempotencyKey?: string } = {},
): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/accounts/${accountId}/funding`,
    headers: { 'idempotency-key': opts.idempotencyKey ?? `fund-${randomUUID()}` },
    payload: { amount, currency: opts.currency ?? 'USD' },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

export async function transfer(
  app: FastifyInstance,
  input: {
    sourceAccountId: string;
    destinationAccountId: string;
    amount: string | number;
    currency?: string;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
    reference?: string;
  },
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const payload: Record<string, unknown> = {
    sourceAccountId: input.sourceAccountId,
    destinationAccountId: input.destinationAccountId,
    amount: input.amount,
    currency: input.currency ?? 'USD',
  };
  if (input.metadata) payload['metadata'] = input.metadata;
  if (input.reference) payload['reference'] = input.reference;

  const res = await app.inject({
    method: 'POST',
    url: '/v1/transfers',
    headers: { 'idempotency-key': input.idempotencyKey ?? `xfer-${randomUUID()}` },
    payload,
  });
  return { statusCode: res.statusCode, body: res.json<Record<string, unknown>>() };
}
