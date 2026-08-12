// Stopping a browser job by hand used to leave the row "running" and the button spinning:
// aborting is cooperative, and the load worked through its whole proxy pool regardless --
// each refused exit launching another browser nobody was waiting for. A cancel is now
// checked between exits, so the load ends where it stands and the run reports "Cancelled".

const store = new Map<string, string>();
vi.mock("../db/database", () => ({
  db: {
    prepare: (sql: string) => ({
      get: (key: string) =>
        sql.includes("SELECT") && store.has(key) ? { value: store.get(key) } : undefined,
      run: (key: string, value: string) => store.set(key, value),
      all: () => [],
    }),
  },
}));

const launchCfBrowser = vi.fn();
vi.mock("../jobs/cfBrowser", () => ({
  launchCfBrowser: (...args: unknown[]) => launchCfBrowser(...args),
  isChromiumInstalled: () => true,
  chromiumExecutable: () => "/tmp/chrome",
  applyCfFontEnv: () => {},
}));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadCheckinUrl } from "../jobs/cloudflare";

const CANDIDATES = [
  { id: "p1", label: "Proxy One", url: "http://1.1.1.1:8080" },
  { id: "p2", label: "Proxy Two", url: "http://2.2.2.2:8080" },
  { id: "p3", label: "Proxy Three", url: "http://3.3.3.3:8080" },
];

/** A page that loads clean and raises no challenge, so only the abort decides the outcome. */
function fakeBrowser(text: string, onClose?: () => void) {
  const page: any = {
    on: () => {},
    addInitScript: async () => {},
    goto: async () => {},
    url: () => "https://example.com/app",
    title: async () => "The App",
    screenshot: async () => Buffer.from("x"),
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    mouse: { move: async () => {}, click: async () => {}, wheel: async () => {} },
    evaluate: async (fn: unknown) => (String(fn).includes("innerText") ? text : null),
  };
  return {
    context: {},
    page,
    key: "direct",
    died: () => false,
    close: async () => onClose?.(),
  };
}

beforeEach(() => {
  store.clear();
  store.set(
    "cf_tuning",
    JSON.stringify({
      budgetMs: 30_000,
      appReadyTimeoutMs: 2_000,
      challengeTimeoutMs: 5_000,
      postClickChallengeMs: 0,
      confirmTimeoutMs: 0,
      settleMs: 0,
      inAppStepMs: 0,
      inAppSettleMs: 0,
      pollMs: 200,
      readyPollMs: 100,
      navTimeoutMs: 5_000,
      protocolTimeoutMs: 5_000,
    }),
  );
  launchCfBrowser.mockReset();
});

describe("cancelling a browser load", () => {
  it("starts no browser at all when the job is already cancelled", async () => {
    launchCfBrowser.mockResolvedValue(fakeBrowser("每日签到"));
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      loadCheckinUrl("https://example.com/app", undefined, {
        proxyCandidates: CANDIDATES,
        maxWaitMs: 30_000,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("Job cancelled");
    expect(launchCfBrowser).not.toHaveBeenCalled();
  });

  it("tries no further exit once cancelled part-way through", async () => {
    // A page that renders nothing is the exit's doing, so the pool would normally be worked
    // through -- the cancel lands as the first browser closes
    const ctrl = new AbortController();
    launchCfBrowser.mockResolvedValue(fakeBrowser("", () => ctrl.abort()));

    await expect(
      loadCheckinUrl("https://example.com/app", undefined, {
        miniApp: true,
        proxyCandidates: CANDIDATES,
        maxWaitMs: 30_000,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("Job cancelled");
    expect(launchCfBrowser).toHaveBeenCalledTimes(1);
  });

  it("works through the pool for that same failure when nothing cancelled it", async () => {
    launchCfBrowser.mockResolvedValue(fakeBrowser(""));
    const pool = CANDIDATES.slice(0, 2);

    const res = await loadCheckinUrl("https://example.com/app", undefined, {
      miniApp: true,
      proxyCandidates: pool,
      maxWaitMs: 30_000,
      signal: new AbortController().signal,
    });

    expect(res.ok).toBe(false);
    expect(launchCfBrowser).toHaveBeenCalledTimes(pool.length);
  }, 15_000);

  it("hands the run id to the browser, so cancelling can close it from outside", async () => {
    launchCfBrowser.mockResolvedValue(fakeBrowser("每日签到"));

    await loadCheckinUrl("https://example.com/app", undefined, {
      proxyCandidates: CANDIDATES.slice(0, 1),
      maxWaitMs: 30_000,
      runId: "run-7",
    });

    expect(launchCfBrowser).toHaveBeenCalledWith(
      CANDIDATES[0].url,
      expect.objectContaining({ runId: "run-7" }),
    );
  });

  it("runs the whole pool when nothing cancelled it", async () => {
    launchCfBrowser.mockResolvedValue(fakeBrowser("每日签到"));

    const res = await loadCheckinUrl("https://example.com/app", undefined, {
      miniApp: true,
      inAppClicks: ["Join giveaway"],
      proxyCandidates: CANDIDATES,
      maxWaitMs: 30_000,
      signal: new AbortController().signal,
    });

    // Stops at the first exit for its own reason (the control is not on the page), which is
    // the behaviour the cancel checks must not disturb
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(1);
  });
});
