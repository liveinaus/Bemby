import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  acquireBulkRunSlot,
  bulkRunSlotUsage,
  resetBulkRunSlots,
} from "../jobs/runSlots";

const never = () => false;
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("bulk run slots", () => {
  beforeEach(() => {
    process.env.BULK_RUN_MAX_CONCURRENT = "2";
    resetBulkRunSlots();
  });
  afterEach(() => {
    resetBulkRunSlots();
    delete process.env.BULK_RUN_MAX_CONCURRENT;
  });

  it("hands out up to the cap and queues the rest", async () => {
    const first = await acquireBulkRunSlot(never);
    const second = await acquireBulkRunSlot(never);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    let third: Awaited<ReturnType<typeof acquireBulkRunSlot>> | undefined;
    const pending = acquireBulkRunSlot(never).then((slot) => (third = slot));
    await flush();
    expect(third).toBeUndefined();
    expect(bulkRunSlotUsage()).toEqual({ held: 2, waiting: 1, max: 2 });

    first!.release();
    await pending;
    expect(third).not.toBeNull();
    expect(bulkRunSlotUsage().held).toBe(2);

    second!.release();
    third!.release();
    expect(bulkRunSlotUsage()).toEqual({ held: 0, waiting: 0, max: 2 });
  });

  it("releasing twice frees only one slot", async () => {
    const slot = await acquireBulkRunSlot(never);
    slot!.release();
    slot!.release();
    expect(bulkRunSlotUsage().held).toBe(0);
  });

  it("gives up the place when the queue is terminated while waiting", async () => {
    const held = [
      await acquireBulkRunSlot(never),
      await acquireBulkRunSlot(never),
    ];
    let cancelled = false;
    const waited = acquireBulkRunSlot(() => cancelled);
    await flush();
    cancelled = true;

    expect(await waited).toBeNull();
    expect(bulkRunSlotUsage().waiting).toBe(0);
    for (const slot of held) slot!.release();
    expect(bulkRunSlotUsage().held).toBe(0);
  });

  it("refuses a slot to a caller already terminated", async () => {
    expect(await acquireBulkRunSlot(() => true)).toBeNull();
    expect(bulkRunSlotUsage().held).toBe(0);
  });
});
