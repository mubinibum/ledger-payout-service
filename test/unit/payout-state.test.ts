import { describe, expect, it } from 'vitest';
import {
  CANCELLABLE_STATUSES,
  InvalidPayoutTransitionError,
  PAYOUT_STATUSES,
  assertTransition,
  canTransition,
  isManualReview,
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
      ['requested', 'manual_review'],
      ['queued', 'processing'],
      ['queued', 'cancelled'],
      ['queued', 'manual_review'],
      ['processing', 'submitted'],
      ['processing', 'succeeded'],
      ['processing', 'failed'],
      ['processing', 'queued'],
      ['processing', 'manual_review'],
      ['submitted', 'succeeded'],
      ['submitted', 'failed'],
      ['submitted', 'manual_review'],
      ['manual_review', 'succeeded'],
      ['manual_review', 'failed'],
      ['manual_review', 'submitted'],
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
      // manual_review is left only by an explicit internal resolution
      ['manual_review', 'requested'],
      ['manual_review', 'queued'],
      ['manual_review', 'cancelled'],
      ['manual_review', 'processing'],
    ];
    for (const [from, to] of bad) {
      expect(canTransition(from as never, to as never), `${from}->${to}`).toBe(false);
      expect(() => assertTransition(from as never, to as never)).toThrow(
        InvalidPayoutTransitionError,
      );
    }
  });

  it('manual_review is non-terminal and non-cancellable', () => {
    expect(isTerminal('manual_review')).toBe(false);
    expect(isManualReview('manual_review')).toBe(true);
    expect(CANCELLABLE_STATUSES.has('manual_review')).toBe(false);
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
