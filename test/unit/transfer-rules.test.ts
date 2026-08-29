import { describe, expect, it } from 'vitest';
import {
  applyCredit,
  applyDebit,
  assertActive,
  assertCurrency,
  assertDistinctAccounts,
  type AccountFacts,
} from '../../src/domain/transfer-rules.js';
import {
  AccountNotActiveError,
  CurrencyMismatchError,
  InsufficientFundsError,
  SameAccountError,
} from '../../src/domain/errors.js';

const account = (over: Partial<AccountFacts> = {}): AccountFacts => ({
  id: 'acct-1',
  status: 'active',
  currency: 'USD',
  allowOverdraft: false,
  balanceMinor: 1000n,
  ...over,
});

describe('transfer-rules', () => {
  it('rejects a transfer to the same account', () => {
    expect(() => assertDistinctAccounts('a', 'a')).toThrow(SameAccountError);
    expect(() => assertDistinctAccounts('a', 'b')).not.toThrow();
  });

  it('rejects a non-active account', () => {
    expect(() => assertActive(account({ status: 'frozen' }))).toThrow(AccountNotActiveError);
    expect(() => assertActive(account({ status: 'closed' }))).toThrow(AccountNotActiveError);
    expect(() => assertActive(account())).not.toThrow();
  });

  it('rejects a currency mismatch (ignoring char(3) padding)', () => {
    expect(() => assertCurrency('USD', 'EUR')).toThrow(CurrencyMismatchError);
    expect(() => assertCurrency('USD ', 'USD')).not.toThrow();
  });

  it('rejects a debit that would overdraw a non-overdraft account', () => {
    expect(() => applyDebit(account({ balanceMinor: 100n }), 101n)).toThrow(InsufficientFundsError);
  });

  it('allows a debit exactly to zero', () => {
    expect(applyDebit(account({ balanceMinor: 100n }), 100n)).toBe(0n);
  });

  it('allows an overdraft account to go negative', () => {
    expect(applyDebit(account({ balanceMinor: 0n, allowOverdraft: true }), 500n)).toBe(-500n);
  });

  it('credits add to the balance', () => {
    expect(applyCredit(account({ balanceMinor: 1000n }), 250n)).toBe(1250n);
  });
});
