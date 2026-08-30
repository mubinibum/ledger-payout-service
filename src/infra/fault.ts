import { loadEnv } from '../config/env.js';

/**
 * Deterministic fault injection for tests — NOT a runtime feature.
 *
 * `maybeFault(point)` is a cheap no-op unless a test has armed that point with `armFault`.
 * `armFault` refuses to do anything when `NODE_ENV === 'production'`, so a production build
 * cannot have faults injected even if this were reached. There is no HTTP surface for it.
 */
export type FaultPoint =
  | 'after_payout_insert'
  | 'after_reservation_entries'
  | 'after_outbox_insert'
  | 'after_provider_accept'
  | 'after_enqueue_before_outbox_update'
  | 'webhook_accounting_transition'
  | 'reconciliation_transition';

export class InjectedFault extends Error {
  readonly isInjectedFault = true;
  constructor(point: FaultPoint) {
    super(`injected fault: ${point}`);
    this.name = 'InjectedFault';
  }
}

export function isInjectedFault(err: unknown): err is InjectedFault {
  return err instanceof InjectedFault;
}

const armed = new Map<FaultPoint, { error: Error; times: number }>();

export function armFault(point: FaultPoint, error?: Error, times = 1): void {
  if (loadEnv().NODE_ENV === 'production') return;
  armed.set(point, { error: error ?? new InjectedFault(point), times });
}

export function clearFaults(): void {
  armed.clear();
}

/** Throws (and consumes one use) if `point` is currently armed. */
export function maybeFault(point: FaultPoint): void {
  const entry = armed.get(point);
  if (!entry) return;
  entry.times -= 1;
  if (entry.times <= 0) armed.delete(point);
  throw entry.error;
}
