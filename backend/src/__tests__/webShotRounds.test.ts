// How many pictures a loop is allowed to leave behind. A `web_for_each` over a page's worth
// of items runs the same steps over and over, and it was those rounds that put 493 images in
// one job log. The later rounds keep a picture only of what failed, which is the one that
// says why the loop stopped.

vi.mock("../db/database", () => ({
  db: {
    prepare: () => ({
      get: () => ({
        value: JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0, readyPollMs: 10, settleMs: 0 }),
      }),
      run: () => {},
      all: () => [],
    }),
  },
}));

import { describe, it, expect, vi } from "vitest";
import type { Page } from "playwright-core";
import { runWebSteps } from "../jobs/cloudflare";
import type { WebStep } from "../types";

/** A stand-in page that really does hand back a picture, so the capture rules are visible. */
function fakePage() {
  let shots = 0;
  const page = {
    title: async () => "",
    url: () => "https://example.test/",
    goto: async () => {},
    screenshot: async () => {
      shots++;
      return Buffer.from("a jpeg, near enough");
    },
    evaluate: async (fn: unknown) => {
      if (String(fn).includes("challenge-")) return false;
      return "a page with plenty of readable text on it, rather than one still booting up";
    },
  };
  return { page: page as unknown as Page, taken: () => shots };
}

const run = (page: Page, steps: WebStep[]) => runWebSteps(page, steps, Date.now() + 30_000, {});

const OK: WebStep = { type: "web_delay", waitMs: 1 };
const repeat = (times: number, steps: WebStep[]): WebStep =>
  ({ type: "web_repeat", times, steps }) as WebStep;

const roundOf = (iteration?: string) => Number(iteration?.split("/")[0] ?? 0);

describe("screenshots through a loop's rounds", () => {
  it("keeps pictures for the opening rounds and stops after that", async () => {
    const f = fakePage();
    const out = await run(f.page, [repeat(6, [OK])]);

    const inRounds = out.logs.filter((l) => l.iteration);
    expect(inRounds.length).toBe(6); // every round is still logged

    const withShot = inRounds.filter((l) => l.screenshot).map((l) => roundOf(l.iteration));
    expect(withShot).toEqual([1, 2]);
    expect(inRounds.filter((l) => roundOf(l.iteration) > 2).every((l) => !l.screenshot)).toBe(true);
  });

  it("still keeps the picture of a step that failed in a later round", async () => {
    const f = fakePage();
    // A selector nothing on the stand-in page holds, so every round's press fails
    const failing: WebStep = { type: "web_button", selector: "css: #nope" } as WebStep;
    const out = await run(f.page, [repeat(4, [{ ...failing, continueOnError: true } as WebStep])]);

    const failed = out.logs.filter((l) => l.iteration && l.error);
    expect(failed.length).toBeGreaterThan(2);
    expect(failed.every((l) => l.screenshot)).toBe(true);
  });

  it("does not take the screenshots it is not going to keep", async () => {
    const f = fakePage();
    await run(f.page, [repeat(30, [OK])]);
    // One per kept round, not thirty: the cost of a picture is taking it, not storing it
    expect(f.taken()).toBeLessThanOrEqual(4);
  });

  it("leaves a run without loops capturing every step as before", async () => {
    const f = fakePage();
    const out = await run(f.page, [OK, OK, OK]);

    expect(out.logs.filter((l) => l.screenshot)).toHaveLength(3);
    expect(out.logs.every((l) => !l.iteration)).toBe(true);
  });
});
