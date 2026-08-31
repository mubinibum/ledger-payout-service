import { afterEach, describe, expect, it, vi } from 'vitest';
import { onShutdown } from '../../src/infra/lifecycle.js';

/**
 * Graceful-shutdown contract: a SIGTERM/SIGINT runs `cleanup` exactly once and exits 0 on
 * success. A hung cleanup still exits (non-zero) after the deadline.
 */
describe('unit: onShutdown', () => {
  const listeners: Array<[NodeJS.Signals, (...a: unknown[]) => void]> = [];

  afterEach(() => {
    for (const [sig, fn] of listeners) process.removeListener(sig, fn);
    listeners.length = 0;
    vi.restoreAllMocks();
  });

  function install(cleanup: () => Promise<void>, deadlineMs?: number): void {
    const before = new Set(process.listeners('SIGTERM'));
    onShutdown(cleanup, deadlineMs);
    for (const sig of ['SIGTERM', 'SIGINT'] as NodeJS.Signals[]) {
      for (const fn of process.listeners(sig)) {
        if (sig === 'SIGTERM' && before.has(fn)) continue;
        listeners.push([sig, fn as (...a: unknown[]) => void]);
      }
    }
  }

  it('runs cleanup once and exits 0', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    install(cleanup);

    process.emit('SIGTERM');
    process.emit('SIGTERM'); // second signal must be ignored
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero if cleanup rejects', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
    install(vi.fn().mockRejectedValue(new Error('drain failed')));

    process.emit('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
