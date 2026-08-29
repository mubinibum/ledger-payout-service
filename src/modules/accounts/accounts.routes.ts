import type { FastifyInstance } from 'fastify';
import { sendError } from '../../http/errors.js';
import { parseAmount, requireIdempotencyKey } from '../../http/request.js';
import type { AccountsService } from './accounts.service.js';
import {
  accountIdParams,
  createAccountBody,
  fundAccountBody,
  ledgerHistoryQuery,
} from './accounts.schemas.js';

/**
 * Account HTTP surface (v1):
 *   POST /v1/accounts                       create an account
 *   GET  /v1/accounts/:id                   account detail + projected balance
 *   GET  /v1/accounts/:id/ledger-entries    ordered ledger history (keyset pagination)
 *   POST /v1/accounts/:id/funding           dev/test opening balance (balanced ledger txn)
 */
export function accountsRoutes(deps: { accounts: AccountsService }) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post('/v1/accounts', async (request, reply) => {
      try {
        const body = createAccountBody.parse(request.body);
        const account = await deps.accounts.createAccount({
          externalId: body.externalId,
          currency: body.currency,
          allowOverdraft: body.allowOverdraft,
        });
        request.log.info({ accountId: account.id, outcome: 'created' }, 'account_created');
        return await reply.code(201).send({ account });
      } catch (err) {
        return sendError(request, reply, err);
      }
    });

    app.get('/v1/accounts/:id', async (request, reply) => {
      try {
        const { id } = accountIdParams.parse(request.params);
        const account = await deps.accounts.getAccount(id);
        return await reply.send({ account });
      } catch (err) {
        return sendError(request, reply, err);
      }
    });

    app.get('/v1/accounts/:id/ledger-entries', async (request, reply) => {
      try {
        const { id } = accountIdParams.parse(request.params);
        const query = ledgerHistoryQuery.parse(request.query);
        const page = await deps.accounts.getLedgerHistory(id, {
          limit: query.limit,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        });
        return await reply.send({ entries: page.items, nextCursor: page.nextCursor });
      } catch (err) {
        return sendError(request, reply, err);
      }
    });

    app.post('/v1/accounts/:id/funding', async (request, reply) => {
      try {
        const { id } = accountIdParams.parse(request.params);
        const body = fundAccountBody.parse(request.body);
        const idempotencyKey = requireIdempotencyKey(request);
        const amountMinor = parseAmount(body.amount);
        const result = await deps.accounts.fund(
          {
            accountId: id,
            amountMinor,
            currency: body.currency,
            reference: body.reference ?? null,
          },
          idempotencyKey,
        );
        request.log.info(
          {
            accountId: id,
            ledgerTransactionId:
              typeof result.body === 'object' && result.body !== null && 'id' in result.body
                ? (result.body as { id: string }).id
                : undefined,
            outcome: result.statusCode === 201 ? 'funded' : 'idempotent_replay',
          },
          'account_funded',
        );
        return await reply.code(result.statusCode).send({ ledgerTransaction: result.body });
      } catch (err) {
        return sendError(request, reply, err);
      }
    });
  };
}
