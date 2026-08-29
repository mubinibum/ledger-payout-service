import { describe, expect, it } from 'vitest';
import { canonicalJson, requestFingerprint } from '../../src/domain/fingerprint.js';

describe('fingerprint: canonicalJson', () => {
  it('is stable regardless of key order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('sorts nested object keys', () => {
    expect(canonicalJson({ x: { p: 1, q: 2 } })).toBe('{"x":{"p":1,"q":2}}');
  });

  it('drops undefined but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe('fingerprint: requestFingerprint', () => {
  const base = {
    source: 'a',
    destination: 'b',
    amount: '100',
    currency: 'USD',
    reference: null,
    metadata: {},
  };

  it('is identical for the same semantic payload with reordered keys', () => {
    const reordered = {
      metadata: {},
      currency: 'USD',
      destination: 'b',
      amount: '100',
      reference: null,
      source: 'a',
    };
    expect(requestFingerprint('transfer', base)).toBe(requestFingerprint('transfer', reordered));
  });

  it('changes when any field changes', () => {
    expect(requestFingerprint('transfer', base)).not.toBe(
      requestFingerprint('transfer', { ...base, amount: '101' }),
    );
  });

  it('is scoped — same payload, different scope, different hash', () => {
    expect(requestFingerprint('transfer', base)).not.toBe(requestFingerprint('funding', base));
  });

  it('produces a hex sha256 digest', () => {
    expect(requestFingerprint('transfer', base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
