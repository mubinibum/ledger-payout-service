import type { FastifyInstance } from 'fastify';
import { performance } from 'node:perf_hooks';
import { isDomainError } from '../../domain/errors.js';
import { sendError } from '../../http/errors.js';
import { parseAmount, requireIdempotencyKey } from '../../http/request.js';
import { metrics } from '../../infra/metrics.js';
import { createPayoutBody, listPayoutsQuery, payoutIdParams } from './payouts.schemas.js';
import type { PayoutsService } from './payouts.service.js';

/**
 * Payout HTTP surface (v1):
 *   POST /v1/payouts              create a payout (Idempotency-Key required); reserves funds
 *   GET  /v1/payouts/:id          payout detail
 *   GET  /v1/payouts?status=&limit=&cursor=   list (keyset pagination)
 *   POST /v1/payouts/:id/cancel   cancel — only before the request reached the provider
 */
export function payoutRoutes(deps: { payouts: PayoutsService }) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post('/v1/payouts', async (request, reply) => {
      const startedAt = performance.now();
      let idempotencyKey: string | undefined;
      try {
        const body = createPayoutBody.parse(request.body);
        idempotencyKey = requireIdempotencyKey(request);
        const amountMinor = parseAmount(body.amount);

        const result = await deps.payouts.createPayout(
          {
            sourceAccountId: body.sourceAccountId,
            amountMinor,
            currency: body.currency,
            ...(body.externalId ? { externalId: body.externalId } : {}),
            ...(body.reference ? { reference: body.reference } : {}),
            ...(body.metadata ? { metadata: body.metadata } : {}),
          },
          idempotencyKey,
        );

        const payoutId =
          typeof result.body === 'object' && result.body !== null && 'id' in result.body
            ? (result.body as { id: string }).id
            : undefined;
        request.log.info(
          {
            operation: 'payout_create',
            payoutId,
            idempotencyKey,
            outcome: result.statusCode === 201 ? 'reserved' : 'idempotent_replay',
            durationMs: Math.round(performance.now() - startedAt),
          },
          'payout_created',
        );
        return await reply.code(result.statusCode).send({ payout: result.body });
      } catch (err) {
        if (isDomainError(err)) {
          metrics.payoutsFailedTotal.inc({ code: err.code });
          request.log.info(
            {
              operation: 'payout_create',
              idempotencyKey,
              outcome: 'rejected',
              errorCategory: err.code,
            },
            'payout_rejected',
          );
        }
        return sendError(request, reply, err);
      }
    });

    app.get('/v1/payouts/:id', async (request, reply) => {
      try {
        const { id } = payoutIdParams.parse(request.params);
        const payout = await deps.payouts.getPayout(id);
        return await reply.send({ payout });
      } catch (err) {
        return sendError(request, reply, err);
      }
    });

    app.get('/v1/payouts', async (request, reply) => {
      try {
        const query = listPayoutsQuery.parse(request.query);
        const page = await deps.payouts.listPayouts({
          ...(query.status ? { status: query.status } : {}),
          limit: query.limit,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        });
        return await reply.send({ payouts: page.items, nextCursor: page.nextCursor });
      } catch (err) {
        return sendError(request, reply, err);
      }
    });

    app.post('/v1/payouts/:id/cancel', async (request, reply) => {
      try {
        const { id } = payoutIdParams.parse(request.params);
        const payout = await deps.payouts.cancelPayout(id);
        request.log.info(
          { operation: 'payout_cancel', payoutId: id, outcome: payout.status },
          'payout_cancelled',
        );
        return await reply.send({ payout });
      } catch (err) {
        return sendError(request, reply, err);
      }
    });
  };
}
