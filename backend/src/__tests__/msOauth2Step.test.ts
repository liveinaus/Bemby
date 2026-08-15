// Turning a completed sign-in into a refresh token: reading the one-time code off the address
// the browser landed on, handing it to the exchange, and keeping what came back where a later
// run can read it. Driven against a stand-in page and a stub exchange, so what is covered is
// the part that goes wrong in practice -- a redirect that carries a refusal rather than a code,
// and a token that has to reach the data store because the log never carries it.
//
// The loop pieces the same job leans on are here too: the round's position, and a condition
// that looks at a value rather than at the page.

import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { db } from "../db/database";
import { CF_TUNING_KEY } from "../jobs/cfTuning";
import { createFolder, createRecord, readDataValue } from "../db/dataStore";
import { runWebSteps, type WebStepHooks } from "../jobs/cloudflare";
import { authCodeFromUrl } from "../jobs/msOauth2";
import type { WebStep } from "../types";

/** Enough of a page for steps that never touch one; the address is what this suite reads. */
function fakePage(url = "https://login.microsoftonline.com/common/oauth2/nativeclient?code=abc123") {
  const typed: Array<{ selector: string; text: string }> = [];
  const page = {
    title: async () => "",
    url: () => url,
    screenshot: async () => Buffer.from("a jpeg, near enough"),
    keyboard: { press: async () => {}, type: async () => {} },
    mouse: { move: async () => {}, click: async () => {}, down: async () => {}, up: async () => {} },
    // Enough to answer the readiness checks the typing steps make of a real page
    evaluate: async (fn: unknown, arg?: unknown) => {
      const body = String(fn);
      if (typeof arg === "string") {
        if (body.includes("getBoundingClientRect")) return true;
        return "";
      }
      if (body.includes("challenge-")) return false;
      return "a page with plenty of readable text on it";
    },
    fill: async (selector: string, text: string) => typed.push({ selector, text }),
    type: async (selector: string, text: string) => typed.push({ selector, text }),
  };
  return { page: page as unknown as Page, typed };
}

/** Stands in for the backend exchange, recording what the step handed it. */
function fakeExchange(refreshToken = "M.C545_token_value") {
  const calls: Array<Parameters<NonNullable<WebStepHooks["msOauth2Token"]>>[0]> = [];
  const hook: WebStepHooks["msOauth2Token"] = async (q) => {
    calls.push(q);
    return { refreshToken, accessToken: "an access token", expiresIn: 3600, scope: "offline_access" };
  };
  return { hook, calls };
}

const run = (page: Page, steps: WebStep[], hooks: WebStepHooks = {}) =>
  runWebSteps(page, steps, Date.now() + 30_000, hooks);

process.env.DATA_MANAGEMENT = "1";

beforeEach(() => {
  db.prepare("DELETE FROM data_records").run();
  db.prepare("DELETE FROM data_folders").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('data_store_enabled','true')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    CF_TUNING_KEY,
    JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0, readyPollMs: 50 }),
  );
});

describe("authCodeFromUrl", () => {
  it("takes the code out of the query string", () => {
    expect(authCodeFromUrl("https://example.com/nativeclient?code=abc&state=1").code).toBe("abc");
  });

  it("takes one off the fragment as well", () => {
    expect(authCodeFromUrl("https://example.com/nativeclient#code=frag").code).toBe("frag");
  });

  // A refused consent screen leaves the same blank page behind as an unfinished sign-in
  it("reports a refusal rather than calling it a missing code", () => {
    const seen = authCodeFromUrl(
      "https://example.com/nativeclient?error=access_denied&error_description=the+user+said+no",
    );
    expect(seen.code).toBeUndefined();
    expect(seen.error).toContain("access_denied");
    expect(seen.error).toContain("the user said no");
  });

  it("has neither for a page that is not the redirect", () => {
    const seen = authCodeFromUrl("https://login.live.com/oauth20_authorize.srf");
    expect(seen.code).toBeUndefined();
    expect(seen.error).toBeUndefined();
  });
});

describe("web_ms_oauth2", () => {
  it("trades the code on the address and keeps the token where it was asked for", async () => {
    const folderId = createFolder("outlook");
    createRecord(folderId, "nina@outlook.com", { password: "xxxx" });
    const { page } = fakePage();
    const { hook, calls } = fakeExchange();

    const result = await run(
      page,
      [
        {
          type: "web_ms_oauth2",
          varName: "refreshToken",
          tenant: "consumers",
          clientSecret: "{msOauthClientSecret}",
          redirectUri: "https://login.microsoftonline.com/common/oauth2/nativeclient",
          folder: "outlook",
          key: "nina@outlook.com",
          path: "refreshToken",
        },
      ],
      { msOauth2Token: hook },
    );

    expect(result.ok).toBe(true);
    expect(calls[0].code).toBe("abc123");
    expect(calls[0].tenant).toBe("consumers");
    // The name of the secret travels, never a secret itself
    expect(calls[0].clientSecretRef).toBe("{msOauthClientSecret}");
    expect(readDataValue("outlook", "nina@outlook.com", "refreshToken")).toBe("M.C545_token_value");
    // The record it was written into keeps everything else it held
    expect(readDataValue("outlook", "nina@outlook.com", "password")).toBe("xxxx");
  });

  // The run log is kept with the run and travels with any export of it
  it("says how long the token is and no more", async () => {
    const { page } = fakePage();
    const { hook } = fakeExchange();
    const result = await run(
      page,
      [{ type: "web_ms_oauth2", varName: "refreshToken" }],
      { msOauth2Token: hook },
    );

    expect(result.ok).toBe(true);
    expect(result.logs[0].outcome).not.toContain("M.C545_token_value");
    expect(result.logs[0].outcome).toContain("18 character(s)");
  });

  it("fails plainly when the browser is not on the redirect address yet", async () => {
    const { page } = fakePage("https://login.live.com/ppsecure/post.srf");
    const { hook, calls } = fakeExchange();
    const result = await run(
      page,
      [{ type: "web_ms_oauth2", varName: "refreshToken" }],
      { msOauth2Token: hook },
    );

    expect(result.ok).toBe(false);
    expect(result.logs[0].error).toContain("has not landed on the redirect address");
    expect(calls).toHaveLength(0);
  });

  it("says so when the sign-in came back refused", async () => {
    const { page } = fakePage("https://example.com/nativeclient?error=consent_required");
    const { hook } = fakeExchange();
    const result = await run(
      page,
      [{ type: "web_ms_oauth2", varName: "refreshToken" }],
      { msOauth2Token: hook },
    );

    expect(result.ok).toBe(false);
    expect(result.logs[0].error).toContain("consent_required");
  });
});

/** What each step said it did, which is where a branch taken or skipped shows up. */
const outcomes = (logs: Array<{ outcome?: string }>) => logs.map((l) => l.outcome ?? "");

describe("web_if on a value", () => {
  it("holds when the value is not blank, and reads the store inline", async () => {
    const folderId = createFolder("outlook");
    createRecord(folderId, "nina@outlook.com", { refreshToken: "already here" });
    const { page } = fakePage();

    const result = await run(page, [
      {
        type: "web_if",
        check: "value",
        value: "{data.outlook[nina@outlook.com].refreshToken}",
        then: [{ type: "web_delay", waitMs: 0 }],
        otherwise: [{ type: "web_delay", waitMs: 0 }, { type: "web_delay", waitMs: 0 }],
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.logs[0].outcome).toContain("running the 1 then step(s)");
  });

  // What the queue job is built on: skip the records already dealt with
  it("turned round, runs the branch only for a name holding nothing", async () => {
    const { page } = fakePage();
    const result = await run(page, [
      { type: "web_set", vars: [{ name: "savedToken", value: "" }] },
      {
        type: "web_if",
        check: "value",
        value: "{savedToken}",
        negate: true,
        then: [{ type: "web_delay", waitMs: 0 }],
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.logs[1].outcome).toContain("running the 1 then step(s)");
  });

  it("narrows on the words when it is given some", async () => {
    const { page } = fakePage();
    const result = await run(page, [
      { type: "web_set", vars: [{ name: "state", value: "pending review" }] },
      {
        type: "web_if",
        check: "value",
        value: "{state}",
        text: "PENDING",
        then: [{ type: "web_delay", waitMs: 0 }],
        otherwise: [{ type: "web_delay", waitMs: 0 }, { type: "web_delay", waitMs: 0 }],
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.logs[1].outcome).toContain("running the 1 then step(s)");
  });

  // A page check waits the page out; a value has nothing coming, so the wait is skipped
  it("answers at once rather than sitting out the wait", async () => {
    const { page } = fakePage();
    const began = Date.now();
    const result = await run(page, [
      {
        type: "web_if",
        check: "value",
        value: "{neverSet}",
        waitMs: 5000,
        then: [{ type: "web_delay", waitMs: 0 }],
      },
    ]);

    expect(result.ok).toBe(true);
    expect(Date.now() - began).toBeLessThan(2000);
  });
});

describe("a loop's round index", () => {
  // Without it a loop can only take position 0, which means emptying the folder as it goes
  it("lets each round take the record at its own position", async () => {
    const folderId = createFolder("outlook");
    createRecord(folderId, "first@outlook.com", { password: "one" });
    createRecord(folderId, "second@outlook.com", { password: "two" });
    const { page } = fakePage();

    const result = await run(page, [
      {
        type: "web_repeat",
        times: 2,
        betweenMs: 0,
        steps: [{ type: "web_data_pick", folder: "outlook", index: "{i}", varName: "email" }],
      },
    ]);

    expect(result.ok).toBe(true);
    const picked = outcomes(result.logs).filter((line) => line.includes("{email}"));
    expect(picked[0]).toContain("first@outlook.com");
    expect(picked[1]).toContain("second@outlook.com");
  });

  // Rounds are set to a number, folders grow and shrink, so the two rarely agree
  it("ends the loop at the end of the folder rather than failing the rest", async () => {
    const folderId = createFolder("outlook");
    createRecord(folderId, "only@outlook.com", { password: "one" });
    const { page } = fakePage();

    const result = await run(page, [
      {
        type: "web_repeat",
        times: 5,
        betweenMs: 0,
        steps: [
          {
            type: "web_data_pick",
            folder: "outlook",
            index: "{i}",
            varName: "email",
            optional: true,
          },
        ],
      },
    ]);

    expect(result.ok).toBe(true);
    const loopLine = result.logs.find((l) => l.type === "web_repeat")?.outcome ?? "";
    expect(loopLine).toContain("nothing left to pick");
    // The one record, taken once: the four rounds with nothing to take never ran
    expect(outcomes(result.logs).filter((l) => l.includes("only@outlook.com"))).toHaveLength(1);
  });
});
