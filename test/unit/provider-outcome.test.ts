import { describe, expect, it } from 'vitest';
import { ProviderError, classifyTransportError } from '../../src/domain/provider-outcome.js';

describe('provider transport error classification', () => {
  it('passes through an explicit ProviderError classification', () => {
    expect(classifyTransportError(new ProviderError('permanent', 'x'))).toBe('permanent');
    expect(classifyTransportError(new ProviderError('ambiguous', 'x'))).toBe('ambiguous');
  });

  it('connection refused / DNS failures are transient (request never landed)', () => {
    expect(classifyTransportError({ code: 'ECONNREFUSED' })).toBe('transient');
    expect(classifyTransportError({ code: 'ENOTFOUND' })).toBe('transient');
    expect(classifyTransportError({ code: 'EAI_AGAIN' })).toBe('transient');
  });

  it('timeouts / mid-flight resets are ambiguous (provider may have received it)', () => {
    expect(classifyTransportError({ name: 'AbortError' })).toBe('ambiguous');
    expect(classifyTransportError({ name: 'TimeoutError' })).toBe('ambiguous');
    expect(classifyTransportError({ code: 'UND_ERR_HEADERS_TIMEOUT' })).toBe('ambiguous');
    expect(classifyTransportError({ code: 'ECONNRESET' })).toBe('ambiguous');
  });

  it('defaults unknown errors to transient', () => {
    expect(classifyTransportError(new Error('weird'))).toBe('transient');
    expect(classifyTransportError('nope')).toBe('transient');
  });
});
