import { describe, expect, it } from 'vitest';
import { formatMinorUnits, parseMinorUnits } from '../../src/domain/money.js';

describe('money: parseMinorUnits', () => {
  it('accepts a string of digits', () => {
    expect(parseMinorUnits('1500')).toBe(1500n);
  });

  it('accepts a positive safe integer', () => {
    expect(parseMinorUnits(42)).toBe(42n);
  });

  it('rejects zero and negatives', () => {
    expect(() => parseMinorUnits('0')).toThrow(/greater than zero/);
    expect(() => parseMinorUnits(-1)).toThrow();
  });

  it('rejects non-integer numbers', () => {
    expect(() => parseMinorUnits(1.5)).toThrow(/integer/);
  });

  it('rejects non-digit strings', () => {
    expect(() => parseMinorUnits('1.50')).toThrow();
    expect(() => parseMinorUnits('12a')).toThrow();
    expect(() => parseMinorUnits('')).toThrow();
  });

  it('rejects amounts beyond the supported maximum', () => {
    expect(() => parseMinorUnits('1000000000000001')).toThrow(/maximum/);
  });

  it('round-trips through formatMinorUnits', () => {
    expect(formatMinorUnits(parseMinorUnits('999999'))).toBe('999999');
  });
});
