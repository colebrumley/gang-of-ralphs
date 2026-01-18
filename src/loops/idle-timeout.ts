const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds

export class IdleTimeoutError extends Error {
  public readonly idleMs: number;

  constructor(idleMs: number) {
    super(`Agent idle for ${Math.round(idleMs / 1000)}s - no output received`);
    this.name = 'IdleTimeoutError';
    this.idleMs = idleMs;
  }
}

export interface IdleMonitor {
  /** Promise that rejects with IdleTimeoutError if idle timeout is reached */
  promise: Promise<never>;
  /** Call this whenever activity is detected (output received, etc.) */
  recordActivity: () => void;
  /** Cancel the monitor (call in finally block) */
  cancel: () => void;
}

/**
 * Creates an idle monitor that tracks activity and rejects if no activity
 * is recorded within the timeout period.
 *
 * Usage:
 * ```
 * const monitor = createIdleMonitor();
 * try {
 *   for await (const message of query(...)) {
 *     monitor.recordActivity();
 *     // handle message
 *   }
 * } catch (e) {
 *   if (e instanceof IdleTimeoutError) {
 *     // handle timeout
 *   }
 *   throw e;
 * } finally {
 *   monitor.cancel();
 * }
 * ```
 */
export function createIdleMonitor(): IdleMonitor {
  let lastActivityAt = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const promise = new Promise<never>((_, reject) => {
    const check = () => {
      const idleMs = Date.now() - lastActivityAt;
      if (idleMs >= IDLE_TIMEOUT_MS) {
        reject(new IdleTimeoutError(idleMs));
      } else {
        // Schedule next check
        timeoutId = setTimeout(check, CHECK_INTERVAL_MS);
      }
    };

    // Start checking after the first interval
    timeoutId = setTimeout(check, CHECK_INTERVAL_MS);
  });

  return {
    promise,
    recordActivity: () => {
      lastActivityAt = Date.now();
    },
    cancel: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
  };
}
