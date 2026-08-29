import { z } from 'zod';

/** JSON amount: a string of digits, or a positive safe integer. Parsed to `bigint` later. */
export const amountSchema = z.union([
  z.string().regex(/^\d+$/, 'amount must be a string of digits (minor units)'),
  z.number().int().positive(),
]);

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter code');

export const createAccountBody = z
  .object({
    externalId: z.string().min(1).max(200),
    currency: currencySchema,
    allowOverdraft: z.boolean().optional().default(false),
  })
  .strict();

export const fundAccountBody = z
  .object({
    amount: amountSchema,
    currency: currencySchema,
    reference: z.string().min(1).max(200).optional(),
  })
  .strict();

export const accountIdParams = z.object({ id: z.string().uuid() }).strict();

export const ledgerHistoryQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type CreateAccountBody = z.infer<typeof createAccountBody>;
export type FundAccountBody = z.infer<typeof fundAccountBody>;
