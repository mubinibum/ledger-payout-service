import type { FastifyInstance } from 'fastify';
import { performance } from 'node:perf_hooks';
import { isDomainError } from '../../domain/errors.js';
import { sendError } from '../../http/errors.js';
import { parseAmount, requireIdempotencyKey } from '../../http/request.js';
import { metrics } from '../../infra/metrics.js';
import { createTransferBody, transferIdParams } from './transfers.schemas.js';
import type { TransfersService } from './transfers.service.js';

/**
 * Transfer HTTP surface (v1):
 *   POST /v1/transfers                  create an internal transfer (Idempotency-Key required)
 *   GET  /v1/transfers/:id              transfer (ledger transaction) detail + entries
 *   GET  /v1/ledger-transactions/:id    any ledger transaction detail + entries
 */
export function transfersRoutes(deps: { transfers: TransfersService }) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post('/v1/transfers', async (request, reply) => {
      const startedAt = performance.now();
      let idempotencyKey: string | undefined;
      try {
        const body = createTransferBody.parse(request.body);
        idempotencyKey = requireIdempotencyKey(request);
        const amountMinor = parseAmount(body.amount);

        const result = await deps.transfers.createTransfer(
          {
            sourceAccountId: body.sourceAccountId,
            destinationAccountId: body.destinationAccountId,
            amountMinor,
            currency: body.currency,
            reference: body.reference ?? null,
            metadata: body.metadata ?? {},
          },
          idempotencyKey,
        );

        const replay = result.statusCode !== 201;
        request.log.info(
          {
            operation: 'transfer',
            transferId:
              typeof result.body === 'object' && result.body !== null && 'id' in result.body
                ? (result.body as { id: string }).id
                : undefined,
            idempotencyKey,
            outcome: replay ? 'idempotent_replay' : 'committed',
            durationMs: Math.round(performance.now() - startedAt),
          },
          'transfer_completed',
        );
        return await reply.code(result.statusCode).send({ transfer: result.body });
      } catch (err) {
        if (isDomainError(err)) {
          metrics.transfersFailedTotal.inc({ code: err.code });
          request.log.info(
            {
              operation: 'transfer',
              idempotencyKey,
              outcome: 'rejected',
              errorCategory: err.code,
              durationMs: Math.round(performance.now() - startedAt),
            },
            'transfer_rejected',
          );
        }
        return sendError(request, reply, err);
      }
    });

    app.get('/v1/transfers/:id', async (request, reply) => {
      try {
        const { id } = transferIdParams.parse(request.params);
        const transfer = await deps.transfers.getTransfer(id);
        return await reply.send({ transfer });
      } catch (err) {
        return sendError(request, reply, err);
      }
    });

    app.get('/v1/ledger-transactions/:id', async (request, reply) => {
      try {
        const { id } = transferIdParams.parse(request.params);
        const ledgerTransaction = await deps.transfers.getLedgerTransaction(id);
        return await reply.send({ ledgerTransaction });
      } catch (err) {
        return sendError(request, reply, err);
      }
    });
  };
}
