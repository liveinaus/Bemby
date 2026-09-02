// Branches and optional steps in an in-app sequence, driven against a real page.
//
// The tree is unit-tested next door; what needs a browser is what the tree does when it runs:
// that a step marked optional is stepped over rather than ending the sequence, and that a
// branch presses what is actually on the page. The settings row the stub hands back is the
// tuning one, so the pauses a real app needs are not spent here.
vi.mock("../db/database", () => ({
  db: {
    prepare: () => ({
      get: () => ({ value: JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0 }) }),
      run: () => {},
      all: () => [],
    }),
  },
}));

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { chromiumExecutable } from "../jobs/cfBrowser";
import { runInAppClicks } from "../jobs/cloudflare";

const exe = chromiumExecutable("free");

const asPage = (html: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<body style="margin:0">${html}</body>`)}`;

describe.skipIf(!exe)("in-app steps with branches", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const open = async (html: string): Promise<Page> => {
    const p = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await p.goto(asPage(html), { waitUntil: "domcontentloaded" });
    return p;
  };

  const run = (page: Page, steps: string[]) =>
    runInAppClicks(page, steps, Date.now() + 30_000, {});

  it(
    "steps over an optional step that fails, and carries on with the rest",
    async () => {
      const page = await open(
        `<button id="go" onclick="this.textContent='pressed'">立即签到</button>`,
      );
      const out = await run(page, ["?css:#nothing-here", "css:#go"]);
      expect(out.ok).toBe(true);
      expect(out.failure).toBeUndefined();
      expect(out.trace).toMatch(/skipped/);
      expect(await page.evaluate(() => document.querySelector("#go")?.textContent)).toBe(
        "pressed",
      );
      await page.close();
    },
    60_000,
  );

  it(
    "still ends the run on the same step when it is not marked optional",
    async () => {
      const page = await open(`<button id="go">立即签到</button>`);
      const out = await run(page, ["css:#nothing-here", "css:#go"]);
      expect(out.ok).toBe(false);
      expect(out.failure).toBeTruthy();
      await page.close();
    },
    60_000,
  );

  it(
    "takes the then branch when the element it asks about is there",
    async () => {
      const page = await open(
        `<button id="claim" onclick="this.textContent='claimed'">领取</button>` +
          `<button id="other" onclick="this.textContent='other'">别的</button>`,
      );
      const out = await run(page, ["if(css:#claim)", "css:#claim", "else", "css:#other", "endif"]);
      expect(out.ok).toBe(true);
      expect(out.trace).toMatch(/if\(css:#claim\) held/);
      const [claim, other] = await page.evaluate(() => [
        document.querySelector("#claim")?.textContent,
        document.querySelector("#other")?.textContent,
      ]);
      expect(claim).toBe("claimed");
      expect(other).toBe("别的");
      await page.close();
    },
    60_000,
  );

  it(
    "takes the else branch when it is not, and presses nothing of the other one",
    async () => {
      const page = await open(
        `<button id="other" onclick="this.textContent='other'">别的</button>`,
      );
      const out = await run(page, ["if(css:#claim)", "css:#claim", "else", "css:#other", "endif"]);
      expect(out.ok).toBe(true);
      expect(out.trace).toMatch(/did not hold/);
      expect(await page.evaluate(() => document.querySelector("#other")?.textContent)).toBe(
        "other",
      );
      await page.close();
    },
    60_000,
  );

  it(
    "judges a text condition on what the page says, and inverts it on request",
    async () => {
      const page = await open(
        `<p>今日已签到</p><button id="go" onclick="this.textContent='pressed'">立即签到</button>`,
      );
      const out = await run(page, ["if(!text:已签到)", "css:#go", "endif"]);
      expect(out.ok).toBe(true);
      expect(out.trace).toMatch(/if\(!text:已签到\) did not hold/);
      // The page already said it was done, so the branch was skipped and nothing was pressed
      expect(await page.evaluate(() => document.querySelector("#go")?.textContent)).toBe(
        "立即签到",
      );
      await page.close();
    },
    60_000,
  );

  it(
    "reports a sequence whose blocks do not line up, and presses nothing",
    async () => {
      const page = await open(
        `<button id="go" onclick="this.textContent='pressed'">立即签到</button>`,
      );
      const out = await run(page, ["if(css:#go)", "css:#go"]);
      expect(out.ok).toBe(false);
      expect(out.failure).toMatch(/no `endif`/);
      expect(await page.evaluate(() => document.querySelector("#go")?.textContent)).toBe(
        "立即签到",
      );
      await page.close();
    },
    60_000,
  );
});
