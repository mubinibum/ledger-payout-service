import { z } from 'zod';

/** Generic provider webhook envelope (invented for this project). */
export const providerWebhookBody = z
  .object({
    eventId: z.string().min(1).max(200),
    type: z.enum(['payout.succeeded', 'payout.failed']),
    providerPayoutId: z.string().min(1).max(200).nullable().optional(),
    idempotencyKey: z.string().min(1).max(200),
    failureCategory: z.string().min(1).max(100).optional(),
  })
  .strict();

export type ProviderWebhookBody = z.infer<typeof providerWebhookBody>;
