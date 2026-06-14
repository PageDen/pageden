// Small, framework-free concurrency helpers used by the background-sync engine. Kept pure so
// the loop-safety and debounce behaviour can be unit-tested without an Obsidian runtime.

/**
 * Serialises async passes so only one runs at a time. If `run()` is called while a pass is in
 * flight, exactly one follow-up pass is queued (further calls collapse into that single pending
 * run) — so overlapping triggers (startup + interval + a modify event) never race the API.
 */
export function createSyncRunner(pass: () => Promise<void>): { run: () => Promise<void>; isRunning: () => boolean } {
  let inFlight = false;
  let pending = false;
  async function run(): Promise<void> {
    if (inFlight) {
      pending = true; // collapse all overlapping triggers into a single follow-up
      return;
    }
    inFlight = true;
    try {
      // Loop (not recursion) so sustained triggers can't build an unbounded promise chain.
      do {
        pending = false;
        await pass();
      } while (pending);
    } finally {
      inFlight = false;
    }
  }
  return { run, isRunning: () => inFlight };
}

/**
 * Per-key debouncer: repeated `schedule(key, fn)` calls within `ms` collapse into a single
 * trailing invocation of the most recent `fn` for that key.
 */
export function createDebouncer(ms: number): {
  schedule: (key: string, fn: () => void) => void;
  cancel: (key: string) => void;
  cancelAll: () => void;
} {
  const timers = new Map<string, number>();
  function cancel(key: string): void {
    const existing = timers.get(key);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      timers.delete(key);
    }
  }
  return {
    schedule(key: string, fn: () => void): void {
      cancel(key);
      timers.set(
        key,
        window.setTimeout(() => {
          timers.delete(key);
          fn();
        }, ms),
      );
    },
    cancel,
    cancelAll(): void {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    },
  };
}
