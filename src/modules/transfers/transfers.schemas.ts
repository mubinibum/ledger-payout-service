import { z } from 'zod';
import { amountSchema, currencySchema } from '../accounts/accounts.schemas.js';

const metadataSchema = z
  .record(z.unknown())
  .refine((m) => Object.keys(m).length <= 20, 'metadata may have at most 20 keys')
  .refine((m) => JSON.stringify(m).length <= 4096, 'metadata is too large (max 4 KB)');

export const createTransferBody = z
  .object({
    sourceAccountId: z.string().uuid(),
    destinationAccountId: z.string().uuid(),
    amount: amountSchema,
    currency: currencySchema,
    reference: z.string().min(1).max(200).optional(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export const transferIdParams = z.object({ id: z.string().uuid() }).strict();

export type CreateTransferBody = z.infer<typeof createTransferBody>;
