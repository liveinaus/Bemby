// Cap on job runs in flight across every background bulk queue. Queues are now
// scoped per template and several run side by side, so the queue is no longer what
// limits load -- this is. Waiters are served oldest first, and a queue that is
// terminated while waiting gives up its place instead of holding one.

const DEFAULT_MAX_CONCURRENT_BULK_RUNS = 2;

function configuredMax(): number {
  const raw = Number(process.env.BULK_RUN_MAX_CONCURRENT);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_CONCURRENT_BULK_RUNS;
  return Math.floor(raw);
}

type Waiter = {
  resolve: (slot: RunSlot | null) => void;
  cancelled: () => boolean;
  timer: ReturnType<typeof setInterval>;
};

/** Held for the length of one run; release exactly once, in a finally. */
export type RunSlot = { release: () => void };

const CANCEL_POLL_MS = 250;

let held = 0;
const waiting: Waiter[] = [];

function makeSlot(): RunSlot {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      // Handed straight to the next live waiter, so the count never dips and
      // a newly arriving caller cannot jump the queue
      while (waiting.length) {
        const next = waiting.shift()!;
        clearInterval(next.timer);
        if (next.cancelled()) continue;
        next.resolve(makeSlot());
        return;
      }
      // Floor at zero: a slot released after a reset must not lend out a spare one
      held = Math.max(0, held - 1);
    },
  };
}

/**
 * Takes a slot for one run, waiting when the cap is reached.
 *
 * Returns null when the caller was terminated while waiting -- the run must then be
 * skipped rather than started late.
 */
export function acquireBulkRunSlot(
  cancelled: () => boolean,
): Promise<RunSlot | null> {
  if (cancelled()) return Promise.resolve(null);
  if (held < configuredMax()) {
    held++;
    return Promise.resolve(makeSlot());
  }
  return new Promise((resolve) => {
    const waiter: Waiter = {
      resolve,
      cancelled,
      timer: setInterval(() => {
        if (!cancelled()) return;
        const at = waiting.indexOf(waiter);
        if (at >= 0) waiting.splice(at, 1);
        clearInterval(waiter.timer);
        resolve(null);
      }, CANCEL_POLL_MS),
    };
    waiting.push(waiter);
  });
}

/** How many runs are in flight and how many queues are waiting behind them. */
export function bulkRunSlotUsage(): { held: number; waiting: number; max: number } {
  return { held, waiting: waiting.length, max: configuredMax() };
}

/** Test seam: drop every slot and waiter. */
export function resetBulkRunSlots(): void {
  for (const waiter of waiting.splice(0)) {
    clearInterval(waiter.timer);
    waiter.resolve(null);
  }
  held = 0;
}
