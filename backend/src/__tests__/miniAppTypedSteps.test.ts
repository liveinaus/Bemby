// A Mini App action drives its page with the same typed steps a plain page takes, which is
// where a branch and a step allowed to fail come from. What needs guarding is the one
// consequence: an empty label list used to mean "find a checkin control yourself", and after
// typed steps have already pressed what the author asked for, a guess on top is the last
// thing wanted.
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

describe.skipIf(!exe)("an empty in-app list", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** An app page with one checkin-worded control on it, which is what the fallback hunts for. */
  const open = async (): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(
      asPage(`<button id="go" onclick="this.textContent='pressed'">签到</button>`),
      { waitUntil: "domcontentloaded" },
    );
    return page;
  };

  it("still finds a checkin control by itself when nothing else drove the app", async () => {
    const page = await open();
    const out = await runInAppClicks(page, [], Date.now() + 30_000, {});
    expect(out.acted).toBe(true);
    expect(await page.evaluate(() => document.querySelector("#go")?.textContent)).toBe(
      "pressed",
    );
    await page.close();
  }, 60_000);

  it("presses nothing when the action's typed steps already drove it", async () => {
    const page = await open();
    const out = await runInAppClicks(page, [], Date.now() + 30_000, { autoDetect: false });
    expect(out.ok).toBe(true);
    expect(out.acted).toBe(false);
    expect(await page.evaluate(() => document.querySelector("#go")?.textContent)).toBe("签到");
    await page.close();
  }, 60_000);
});
