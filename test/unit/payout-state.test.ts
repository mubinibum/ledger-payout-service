import { describe, expect, it } from 'vitest';
import {
  CANCELLABLE_STATUSES,
  InvalidPayoutTransitionError,
  PAYOUT_STATUSES,
  assertTransition,
  canTransition,
  isTerminal,
} from '../../src/domain/payout-state.js';

describe('payout state machine', () => {
  it('marks the three terminal states', () => {
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    for (const s of ['requested', 'queued', 'processing', 'submitted'] as const) {
      expect(isTerminal(s)).toBe(false);
    }
  });

  it('allows the documented forward transitions', () => {
    const ok: [string, string][] = [
      ['requested', 'queued'],
      ['requested', 'processing'],
      ['requested', 'cancelled'],
      ['queued', 'processing'],
      ['queued', 'cancelled'],
      ['processing', 'submitted'],
      ['processing', 'succeeded'],
      ['processing', 'failed'],
      ['processing', 'queued'],
      ['submitted', 'succeeded'],
      ['submitted', 'failed'],
    ];
    for (const [from, to] of ok) {
      expect(canTransition(from as never, to as never), `${from}->${to}`).toBe(true);
    }
  });

  it('rejects illegal transitions', () => {
    const bad: [string, string][] = [
      ['requested', 'submitted'],
      ['requested', 'succeeded'],
      ['queued', 'succeeded'],
      ['submitted', 'processing'],
      ['submitted', 'cancelled'],
      ['succeeded', 'failed'],
      ['failed', 'succeeded'],
      ['cancelled', 'processing'],
    ];
    for (const [from, to] of bad) {
      expect(canTransition(from as never, to as never), `${from}->${to}`).toBe(false);
      expect(() => assertTransition(from as never, to as never)).toThrow(
        InvalidPayoutTransitionError,
      );
    }
  });

  it('terminal states permit no outgoing transition', () => {
    for (const terminal of ['succeeded', 'failed', 'cancelled'] as const) {
      for (const to of PAYOUT_STATUSES) {
        if (to === terminal) continue;
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('treats re-applying the same status as a no-op (allowed)', () => {
    for (const s of PAYOUT_STATUSES) expect(canTransition(s, s)).toBe(true);
  });

  it('only requested/queued are cancellable', () => {
    expect([...CANCELLABLE_STATUSES].sort()).toEqual(['queued', 'requested']);
  });
});
