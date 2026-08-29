import {
  AccountNotActiveError,
  CurrencyMismatchError,
  InsufficientFundsError,
  SameAccountError,
} from './errors.js';

/**
 * Pure transfer pre-conditions, independent of the database. The transfer service calls
 * these against freshly-locked account rows; they are also unit-tested in isolation.
 */

export interface AccountFacts {
  id: string;
  status: string;
  currency: string;
  allowOverdraft: boolean;
  balanceMinor: bigint;
}

export function assertDistinctAccounts(sourceId: string, destinationId: string): void {
  if (sourceId === destinationId) throw new SameAccountError();
}

export function assertActive(account: Pick<AccountFacts, 'id' | 'status'>): void {
  if (account.status !== 'active') {
    throw new AccountNotActiveError(account.id, account.status);
  }
}

export function assertCurrency(expected: string, actual: string): void {
  if (expected.trim() !== actual.trim()) {
    throw new CurrencyMismatchError(expected.trim(), actual.trim());
  }
}

/** Returns the resulting source balance; throws if the debit is not allowed. */
export function applyDebit(account: AccountFacts, amountMinor: bigint): bigint {
  const next = account.balanceMinor - amountMinor;
  if (!account.allowOverdraft && next < 0n) {
    throw new InsufficientFundsError(account.id);
  }
  return next;
}

export function applyCredit(account: AccountFacts, amountMinor: bigint): bigint {
  return account.balanceMinor + amountMinor;
}
