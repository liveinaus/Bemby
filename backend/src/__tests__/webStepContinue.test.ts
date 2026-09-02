// A step marked to carry on after failing. What an optional step needs: a cookie banner up
// on the first visit alone, a "maybe later" dialog that only sometimes appears -- neither
// worth failing a run over, and neither expressible while any failing step stops the chain.
//
// Against a stand-in page rather than a real browser: the control flow is the whole point,
// and the real-browser cover skips itself when CloakBrowser is not installed.
vi.mock("../db/database", () => ({
  db: {
    prepare: () => ({
      get: () => ({
        value: JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0, readyPollMs: 50 }),
      }),
      run: () => {},
      all: () => [],
    }),
  },
}));

import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { runWebSteps } from "../jobs/cloudflare";
import type { WebStep } from "../types";

const HOME = "https://forum.example/";

function fakePage() {
  const visited: string[] = [HOME];
  const page = {
    title: async () => "",
    url: () => visited[visited.length - 1],
    goto: async (url: string) => {
      visited.push(url);
    },
    screenshot: async () => {
      throw new Error("the stand-in page takes no screenshots");
    },
    evaluate: async (fn: unknown) => {
      if (String(fn).includes("challenge-")) return false;
      return "a page with plenty of readable text on it, rather than one still booting up";
    },
  };
  return { page: page as unknown as Page, visited };
}

const run = (page: Page, steps: WebStep[]) => runWebSteps(page, steps, Date.now() + 30_000, {});

/** Fails without needing anything of the page: an address that is not one. */
const BAD: WebStep = { type: "web_goto", url: "not-an-address" };
/** Gets through, and says so by where the browser ends up. */
const MARK: WebStep = { type: "web_goto", url: `${HOME}after` };

const wentTo = (visited: string[]) => visited.at(-1)?.replace(HOME, "") ?? "";

describe("carrying on past a step that fails", () => {
  it("stops at the failure when the step is not marked", async () => {
    const f = fakePage();
    const out = await run(f.page, [BAD, MARK]);

    expect(out.ok).toBe(false);
    expect(out.logs).toHaveLength(1);
    expect(wentTo(f.visited)).toBe("");
  });

  it("runs the steps after it when the step is marked", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ ...BAD, continueOnError: true }, MARK]);

    expect(out.ok).toBe(true);
    expect(out.failure).toBeUndefined();
    expect(wentTo(f.visited)).toBe("after");
  });

  it("still logs the failure, marked as one that was stepped over", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ ...BAD, continueOnError: true }]);

    expect(out.logs[0].error).toMatch(/must start with http/);
    expect(out.logs[0].error).toContain("carried on");
  });

  it("carries on inside a branch, without ending the branch", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      {
        type: "web_if",
        check: "text",
        text: "readable",
        then: [{ ...BAD, continueOnError: true }, MARK],
      },
    ]);

    expect(out.ok).toBe(true);
    expect(wentTo(f.visited)).toBe("after");
  });

  it("lets a whole branch be optional when the condition itself is marked", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_if", check: "text", text: "readable", then: [BAD], continueOnError: true },
      MARK,
    ]);

    expect(out.ok).toBe(true);
    expect(out.logs[0].error).toContain("carried on");
    expect(wentTo(f.visited)).toBe("after");
  });

  // The two loops already spell `continueOnError`, where it means the next round rather than
  // the next step. A loop whose every round failed is still a failed step.
  it("does not read a loop's own flag as one to carry on past the loop", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_repeat", times: 2, steps: [BAD], continueOnError: true },
      MARK,
    ]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/0 of 2 round\(s\)/);
    expect(wentTo(f.visited)).toBe("");
  });
});
