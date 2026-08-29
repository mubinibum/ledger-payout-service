/**
 * Domain errors. Every expected failure of a use case is one of these; the HTTP layer
 * maps `code` → response body and `httpStatus` → status code (see `src/http/errors.ts`).
 * Anything that is NOT a `DomainError` is an unexpected fault and becomes a 500 with no
 * internal detail leaked to the client.
 */
export type DomainErrorCode =
  | 'validation_error'
  | 'account_not_found'
  | 'account_not_active'
  | 'currency_mismatch'
  | 'insufficient_funds'
  | 'same_account'
  | 'idempotency_key_required'
  | 'idempotency_conflict'
  | 'request_in_progress'
  | 'funding_disabled'
  | 'unsupported_currency'
  | 'not_found';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DomainErrorCode,
    httpStatus: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    if (details) this.details = details;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_error', 400, message, details);
  }
}

export class AccountNotFoundError extends DomainError {
  constructor(accountId: string) {
    super('account_not_found', 404, 'account not found', { accountId });
  }
}

export class AccountNotActiveError extends DomainError {
  constructor(accountId: string, status: string) {
    super('account_not_active', 409, `account is ${status}, not active`, { accountId, status });
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super('currency_mismatch', 409, 'accounts and amount must share one currency', {
      expected,
      actual,
    });
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(accountId: string) {
    super('insufficient_funds', 422, 'insufficient funds in source account', { accountId });
  }
}

export class SameAccountError extends DomainError {
  constructor() {
    super('same_account', 400, 'source and destination accounts must differ');
  }
}

export class IdempotencyKeyRequiredError extends DomainError {
  constructor() {
    super('idempotency_key_required', 400, 'Idempotency-Key header is required');
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super(
      'idempotency_conflict',
      409,
      'Idempotency-Key was already used with a different request payload',
    );
  }
}

export class RequestInProgressError extends DomainError {
  constructor() {
    super('request_in_progress', 409, 'a request with this Idempotency-Key is still in progress');
  }
}

export class FundingDisabledError extends DomainError {
  constructor() {
    super('funding_disabled', 403, 'funding is disabled on this instance (ALLOW_FUNDING=false)');
  }
}

export class UnsupportedCurrencyError extends DomainError {
  constructor(currency: string) {
    super('unsupported_currency', 422, `no system account for currency ${currency}`, { currency });
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super('not_found', 404, `${what} not found`);
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
