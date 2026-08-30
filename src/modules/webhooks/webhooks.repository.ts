import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { ProviderWebhookEventsTable } from '../../db/schema.js';
import type { Executor } from '../../infra/tx.js';

export type WebhookEventRow = Selectable<ProviderWebhookEventsTable>;

export interface NewWebhookEvent {
  providerEventId: string;
  eventType: string;
  providerPayoutId: string | null;
  payloadHash: string;
}

/**
 * Inserts a receipt for `provider_event_id`. Returns the row, or `null` if the id was
 * already seen. `ON CONFLICT DO NOTHING` (rather than catching a unique violation) keeps
 * the surrounding transaction usable for the follow-up read, and still blocks a concurrent
 * duplicate until the first transaction resolves.
 */
export async function insertWebhookEvent(
  db: Executor,
  input: NewWebhookEvent,
): Promise<WebhookEventRow | null> {
  const row = await db
    .insertInto('provider_webhook_events')
    .values({
      provider_event_id: input.providerEventId,
      event_type: input.eventType,
      provider_payout_id: input.providerPayoutId,
      payload_hash: input.payloadHash,
    })
    .onConflict((oc) => oc.column('provider_event_id').doNothing())
    .returningAll()
    .executeTakeFirst();
  return row ?? null;
}

export async function findWebhookEvent(
  db: Executor,
  providerEventId: string,
): Promise<WebhookEventRow | undefined> {
  return db
    .selectFrom('provider_webhook_events')
    .selectAll()
    .where('provider_event_id', '=', providerEventId)
    .executeTakeFirst();
}

export async function markWebhookProcessed(
  db: Executor,
  id: string,
  result: string,
): Promise<void> {
  await db
    .updateTable('provider_webhook_events')
    .set({ result, processed_at: sql`now()` })
    .where('id', '=', id)
    .execute();
}
