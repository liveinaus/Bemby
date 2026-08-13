// A keyed browser that cannot hold its licence session does not fail its launch: it starts,
// answers the driver, and quits about a second later. Every run then reads as a browser that
// died mid-navigation, whatever it was pointed at -- pages never loaded at all, which is what
// sent an operator looking at their template and their proxies instead. Watching the first
// couple of seconds is the only signal there is, so this covers the watching itself.
import { describe, it, expect, vi } from "vitest";
import { exitedAtOnce } from "../jobs/cfBrowser";

/** Just enough of a context: the close event, which is all the watcher listens to. */
function fakeContext(closeAfterMs?: number) {
  const handlers: Array<() => void> = [];
  if (closeAfterMs !== undefined) {
    setTimeout(() => handlers.splice(0).forEach((fn) => fn()), closeAfterMs);
  }
  return {
    once: (_event: string, fn: () => void) => handlers.push(fn),
    listeners: () => handlers,
  } as any;
}

describe("exitedAtOnce", () => {
  it("reports a browser that quits inside the window", async () => {
    expect(await exitedAtOnce(fakeContext(20), 500)).toBe(true);
  });

  it("reports one that stays up, and waits no longer than it was told", async () => {
    const started = Date.now();
    expect(await exitedAtOnce(fakeContext(undefined), 120)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("answers as soon as it quits rather than sitting out the whole window", async () => {
    // The wait is added to every keyed launch, so a quick answer is the point
    const started = Date.now();
    expect(await exitedAtOnce(fakeContext(10), 5_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("drops its timer when the browser quits, so nothing fires later", async () => {
    vi.useFakeTimers();
    try {
      const context = fakeContext(5);
      const answer = exitedAtOnce(context, 2_000);
      await vi.advanceTimersByTimeAsync(10);
      expect(await answer).toBe(true);
      // Nothing left pending: a stray timer here would resolve a settled promise
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
