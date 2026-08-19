import { describe, it, expect, beforeEach } from "vitest";
import {
  cancelBulkTask,
  dismissBulkTask,
  getBulkTask,
  listBulkTasks,
  queuedRefIds,
  resetBulkTasks,
  runningTaskOfKind,
  startBulkTask,
} from "../jobs/bulkTasks";

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function waitForFinish(id: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getBulkTask(id)?.state !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("task did not finish in time");
}

const entries = [
  { refId: 1, refName: "A_1" },
  { refId: 2, refName: "A_2" },
];

describe("bulk task registry", () => {
  beforeEach(() => resetBulkTasks());

  it("runs items in order and records each result", async () => {
    const seen: number[] = [];
    const started = startBulkTask({
      kind: "spam-check",
      entries,
      handler: async (item) => {
        seen.push(item.refId);
        return { message: `checked ${item.refId}`, data: { spamStatus: "free" } };
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForFinish(started.task.id);
    expect(seen).toEqual([1, 2]);
    expect(started.task.state).toBe("completed");
    expect(started.task.items.map((i) => i.status)).toEqual(["done", "done"]);
    expect(started.task.items[0].message).toBe("checked 1");
    expect(started.task.items[0].data).toEqual({ spamStatus: "free" });
  });

  it("keeps going after an item fails and records the reason", async () => {
    const started = startBulkTask({
      kind: "clean",
      entries,
      handler: async (item) => {
        if (item.refId === 1) throw new Error("boom");
        return "cleaned";
      },
    });
    if (!started.ok) throw new Error(started.error);

    await waitForFinish(started.task.id);
    expect(started.task.items[0].status).toBe("failed");
    expect(started.task.items[0].error).toBe("boom");
    expect(started.task.items[1].status).toBe("done");
    expect(started.task.state).toBe("completed");
  });

  it("refuses a second task of the same kind while one is running", async () => {
    const first = startBulkTask({
      kind: "passkey",
      entries,
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });
    if (!first.ok) throw new Error(first.error);

    const second = startBulkTask({
      kind: "passkey",
      entries,
      handler: async () => undefined,
    });
    expect(second.ok).toBe(false);
    // A different kind may run alongside
    const other = startBulkTask({
      kind: "clean",
      entries,
      handler: async () => undefined,
    });
    expect(other.ok).toBe(true);

    await waitForFinish(first.task.id);
  });

  it("runs queues of one kind side by side while their scopes differ", async () => {
    const first = startBulkTask({
      kind: "run-jobs",
      scope: "t1",
      label: "SNTP signup",
      maxRunning: 3,
      entries,
      handler: async (_item, ctx) => ctx.sleep(5000),
    });
    if (!first.ok) throw new Error(first.error);

    const other = startBulkTask({
      kind: "run-jobs",
      scope: "t2",
      label: "Telegram API credentials",
      maxRunning: 3,
      entries: [{ refId: 9, refName: "J_9" }],
      handler: async () => undefined,
    });
    expect(other.ok).toBe(true);

    // The same scope is still one at a time, and says which queue is in the way
    const clash = startBulkTask({
      kind: "run-jobs",
      scope: "t1",
      label: "SNTP signup",
      maxRunning: 3,
      entries,
      handler: async () => undefined,
    });
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.conflictTaskId).toBe(first.task.id);
    expect(clash.error).toContain("SNTP signup");

    cancelBulkTask(first.task.id);
    await waitForFinish(first.task.id);
  });

  it("caps how many queues of one kind run at once", async () => {
    const started = ["a", "b"].map((scope) =>
      startBulkTask({
        kind: "run-jobs",
        scope,
        maxRunning: 2,
        entries,
        handler: async (_item, ctx) => ctx.sleep(5000),
      }),
    );
    expect(started.every((r) => r.ok)).toBe(true);

    const third = startBulkTask({
      kind: "run-jobs",
      scope: "c",
      maxRunning: 2,
      entries,
      handler: async () => undefined,
    });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.conflictTaskId).toBeUndefined();

    for (const result of started) {
      if (!result.ok) continue;
      cancelBulkTask(result.task.id);
      await waitForFinish(result.task.id);
    }
  });

  it("reports the items a running queue still owes work to", async () => {
    const started = startBulkTask({
      kind: "run-jobs",
      scope: "t1",
      entries,
      handler: async (_item, ctx) => ctx.sleep(5000),
    });
    if (!started.ok) throw new Error(started.error);

    await flush();
    expect([...queuedRefIds("run-jobs")].sort()).toEqual([1, 2]);
    // A different kind's queue is not job work
    expect(queuedRefIds("clean").size).toBe(0);

    cancelBulkTask(started.task.id);
    await waitForFinish(started.task.id);
    expect(queuedRefIds("run-jobs").size).toBe(0);
  });

  it("terminates after the item in flight and marks the rest cancelled", async () => {
    let secondStarted = false;
    const started = startBulkTask({
      kind: "credentials",
      entries,
      handler: async (item, ctx) => {
        if (item.refId === 2) secondStarted = true;
        // Long enough that the cancel below lands mid-item
        await ctx.sleep(5000);
        return "done";
      },
    });
    if (!started.ok) throw new Error(started.error);

    await flush();
    expect(cancelBulkTask(started.task.id)).toBe(true);
    await waitForFinish(started.task.id);

    expect(secondStarted).toBe(false);
    expect(started.task.state).toBe("cancelled");
    expect(started.task.items[1].status).toBe("cancelled");
    expect(runningTaskOfKind("credentials")).toBeNull();
  });

  it("waits the configured gap between items", async () => {
    const stamps: number[] = [];
    const started = startBulkTask({
      kind: "fetch-attributes",
      entries,
      gapSeconds: 1,
      handler: async () => {
        stamps.push(Date.now());
      },
    });
    if (!started.ok) throw new Error(started.error);

    await waitForFinish(started.task.id, 5000);
    expect(stamps).toHaveLength(2);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(900);
  });

  it("lists newest first and only dismisses finished tasks", async () => {
    const running = startBulkTask({
      kind: "run-jobs",
      entries,
      handler: async (_item, ctx) => {
        await ctx.sleep(5000);
      },
    });
    if (!running.ok) throw new Error(running.error);

    expect(dismissBulkTask(running.task.id)).toBe(false);
    cancelBulkTask(running.task.id);
    await waitForFinish(running.task.id);
    expect(dismissBulkTask(running.task.id)).toBe(true);
    expect(listBulkTasks()).toHaveLength(0);
  });

  // What an unreachable proxy used to do: the handler never settles, so the queue stopped on
  // that account and Terminate had no effect either.
  it("fails a wedged item and carries on with the rest", async () => {
    const reached: number[] = [];
    const started = startBulkTask({
      kind: "spam-check",
      entries,
      itemTimeoutMs: 60,
      handler: async (item) => {
        reached.push(item.refId);
        // Account 1 hangs for good; account 2 answers straight away
        if (item.refId === 1) await new Promise(() => {});
        return "ok";
      },
    });
    if (!started.ok) throw new Error(started.error);

    await waitForFinish(started.task.id);
    expect(reached).toEqual([1, 2]);
    expect(started.task.items.map((i) => i.status)).toEqual(["failed", "done"]);
    expect(started.task.items[0].error).toMatch(/gave up on this one/);
    expect(started.task.items[1].message).toBe("ok");
    expect(started.task.state).toBe("completed");
  });

  it("terminates a wedged item instead of waiting it out", async () => {
    const started = startBulkTask({
      kind: "spam-check",
      entries,
      itemTimeoutMs: 60_000,
      handler: async () => {
        await new Promise(() => {});
        return "never";
      },
    });
    if (!started.ok) throw new Error(started.error);

    await flush();
    cancelBulkTask(started.task.id);
    await waitForFinish(started.task.id);
    expect(started.task.state).toBe("cancelled");
    expect(started.task.items[0].status).toBe("cancelled");
    expect(started.task.items[0].error).toBeNull();
  });

  it("rejects an empty selection", () => {
    const result = startBulkTask({
      kind: "spam-check",
      entries: [],
      handler: async () => undefined,
    });
    expect(result).toEqual({ ok: false, error: "No items provided" });
  });
});
