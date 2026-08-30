import { z } from 'zod';
import { amountSchema, currencySchema } from '../accounts/accounts.schemas.js';
import { PAYOUT_STATUSES } from '../../domain/payout-state.js';

const metadataSchema = z
  .record(z.unknown())
  .refine((m) => Object.keys(m).length <= 20, 'metadata may have at most 20 keys')
  .refine((m) => JSON.stringify(m).length <= 4096, 'metadata is too large (max 4 KB)');

export const createPayoutBody = z
  .object({
    sourceAccountId: z.string().uuid(),
    amount: amountSchema,
    currency: currencySchema,
    externalId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.:-]+$/, 'externalId may contain letters, digits and _ . : -')
      .optional(),
    reference: z.string().min(1).max(200).optional(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export const payoutIdParams = z.object({ id: z.string().uuid() }).strict();

export const listPayoutsQuery = z
  .object({
    status: z.enum(PAYOUT_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type CreatePayoutBody = z.infer<typeof createPayoutBody>;
