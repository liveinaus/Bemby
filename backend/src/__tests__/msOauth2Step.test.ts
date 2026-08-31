// Connecting a Microsoft mailbox to msOauth2api: opening the sign-in address the service
// hands out, then confirming with the service that the mailbox actually landed. Driven
// against a stand-in page and stubbed calls, so what is covered is the part that goes wrong
// in practice -- a redirect carrying a refusal, and a sign-in that never reached the callback.
//
// No token appears anywhere here, deliberately: msOauth2api stores it and never serves it
// back, so Bemby only writes a marker saying the mailbox is done.
//
// The loop pieces the same job leans on are here too: the round's position, and a condition
// that looks at a value rather than at the page.

import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { db } from "../db/database";
import { CF_TUNING_KEY } from "../jobs/cfTuning";
import { createFolder, createRecord, readDataValue } from "../db/dataStore";
import { runWebSteps, type WebStepHooks } from "../jobs/cloudflare";
import { authErrorFromUrl, msOauthStepsIn } from "../jobs/msOauth2";
import type { WebStep } from "../types";

const CALLBACK = "https://msapi.example.com/api/oauth/callback";

/** Enough of a page for steps that never touch one; the address is what this suite reads. */
function fakePage(url = `${CALLBACK}?code=abc123&state=s1`) {
  const typed: Array<{ selector: string; text: string }> = [];
  const visited: string[] = [];
  let current = url;
  const page = {
    title: async () => "",
    url: () => current,
    goto: async (to: string) => {
      visited.push(to);
      current = to;
      return null;
    },
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
  return { page: page as unknown as Page, typed, visited };
}

/** Stands in for msOauth2api handing out a sign-in address. */
function fakeStart(authorizeUrl = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1") {
  const calls: Array<{ email: string; authType?: string }> = [];
  const hook: WebStepHooks["msOauth2Start"] = async (q) => {
    calls.push(q);
    return { authorizeUrl, redirectUri: CALLBACK };
  };
  return { hook, calls };
}

/** Stands in for the service being asked whether it holds the mailbox. */
function fakeVerify(answer: { stored: boolean; disabled?: boolean; lastRefreshError?: string | null }) {
  const calls: Array<{ email: string }> = [];
  const hook: WebStepHooks["msOauth2Verify"] = async (q) => {
    calls.push(q);
    return answer;
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

describe("authErrorFromUrl", () => {
  // A refused consent screen leaves an ordinary-looking page behind
  it("reports a refusal carried on the query string", () => {
    const seen = authErrorFromUrl(
      `${CALLBACK}?error=access_denied&error_description=the+user+said+no`,
    );
    expect(seen).toContain("access_denied");
    expect(seen).toContain("the user said no");
  });

  it("reads one off the fragment as well", () => {
    expect(authErrorFromUrl(`${CALLBACK}#error=consent_required`)).toContain("consent_required");
  });

  it("has nothing to say about an ordinary address", () => {
    expect(authErrorFromUrl(`${CALLBACK}?code=abc123`)).toBeNull();
    expect(authErrorFromUrl("not an address at all")).toBeNull();
  });
});

describe("web_ms_oauth2_start", () => {
  it("asks the service for the address and takes the browser there", async () => {
    const { page, visited } = fakePage("https://example.com/start");
    const { hook, calls } = fakeStart();

    const result = await run(
      page,
      [{ type: "web_ms_oauth2_start", email: "nina@outlook.com", authType: "imap" }],
      { msOauth2Start: hook },
    );

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual({ email: "nina@outlook.com", authType: "imap" });
    expect(visited[0]).toContain("login.microsoftonline.com");
  });

  it("fills the mailbox in from what the round is on", async () => {
    const { page } = fakePage("https://example.com/start");
    const { hook, calls } = fakeStart();

    await run(
      page,
      [
        { type: "web_set", vars: [{ name: "email", value: "rosa@outlook.com" }] },
        { type: "web_ms_oauth2_start", email: "{email}" },
      ],
      { msOauth2Start: hook },
    );

    expect(calls[0].email).toBe("rosa@outlook.com");
  });

  // The address is a one-shot capability to write an account into the service
  it("keeps the sign-in address out of the run log", async () => {
    const { page } = fakePage("https://example.com/start");
    const { hook } = fakeStart("https://login.microsoftonline.com/consumers/x?state=SECRETSTATE");

    const result = await run(
      page,
      [{ type: "web_ms_oauth2_start", email: "nina@outlook.com" }],
      { msOauth2Start: hook },
    );

    expect(result.logs[0].outcome).not.toContain("SECRETSTATE");
    expect(result.logs[0].outcome).toContain("nina@outlook.com");
  });

  it("says so when there is no mailbox to connect", async () => {
    const { page } = fakePage("https://example.com/start");
    const { hook } = fakeStart();
    const result = await run(page, [{ type: "web_ms_oauth2_start", email: "" }], {
      msOauth2Start: hook,
    });

    expect(result.ok).toBe(false);
    expect(result.logs[0].error).toContain("no mailbox given");
  });
});

describe("web_ms_oauth2", () => {
  it("confirms with the service and marks the record, storing no token", async () => {
    const folderId = createFolder("outlook");
    createRecord(folderId, "nina@outlook.com", { password: "xxxx" });
    const { page } = fakePage();
    const { hook, calls } = fakeVerify({ stored: true });

    const result = await run(
      page,
      [
        {
          type: "web_ms_oauth2",
          email: "nina@outlook.com",
          varName: "connectedAt",
          folder: "outlook",
          key: "nina@outlook.com",
          path: "connectedAt",
        },
      ],
      { msOauth2Verify: hook },
    );

    expect(result.ok).toBe(true);
    expect(calls[0].email).toBe("nina@outlook.com");
    // A timestamp, not a credential
    expect(readDataValue("outlook", "nina@outlook.com", "connectedAt")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The record it was written into keeps everything else it held
    expect(readDataValue("outlook", "nina@outlook.com", "password")).toBe("xxxx");
  });

  it("fails when the service does not hold the mailbox", async () => {
    const { page } = fakePage();
    const { hook } = fakeVerify({ stored: false });
    const result = await run(
      page,
      [{ type: "web_ms_oauth2", email: "nina@outlook.com" }],
      { msOauth2Verify: hook },
    );

    expect(result.ok).toBe(false);
    expect(result.logs[0].error).toContain("does not hold nina@outlook.com");
  });

  // Stored but broken is worse than not stored: the pool would hand the address out
  it("fails when the stored grant is already failing", async () => {
    const { page } = fakePage();
    const { hook } = fakeVerify({ stored: true, lastRefreshError: "AADSTS70000 invalid_grant" });
    const result = await run(
      page,
      [{ type: "web_ms_oauth2", email: "nina@outlook.com" }],
      { msOauth2Verify: hook },
    );

    expect(result.ok).toBe(false);
    expect(result.logs[0].error).toContain("invalid_grant");
  });

  it("says so when the sign-in came back refused, without asking the service", async () => {
    const { page } = fakePage(`${CALLBACK}?error=consent_required`);
    const { hook, calls } = fakeVerify({ stored: true });
    const result = await run(
      page,
      [{ type: "web_ms_oauth2", email: "nina@outlook.com" }],
      { msOauth2Verify: hook },
    );

    expect(result.ok).toBe(false);
    expect(result.logs[0].error).toContain("consent_required");
    expect(calls).toHaveLength(0);
  });
});

// Both halves have to be found wherever they sit, since the run is stopped up front when
// msOauth2api is not configured and these are the steps that need it.
describe("msOauthStepsIn", () => {
  it("finds both step types, including inside a loop", () => {
    const steps = [
      {
        type: "web_for_each",
        varName: "mailboxes",
        steps: [
          { type: "web_ms_oauth2_start", email: "{email}" },
          { type: "web_ms_oauth2", email: "{email}" },
        ],
      },
    ] as WebStep[];
    expect(msOauthStepsIn(steps)).toHaveLength(2);
  });

  it("finds none on a page that has none", () => {
    expect(msOauthStepsIn([{ type: "web_delay", waitMs: 0 }] as WebStep[])).toHaveLength(0);
    expect(msOauthStepsIn(undefined)).toHaveLength(0);
  });
});

/** What each step said it did, which is where a branch taken or skipped shows up. */
const outcomes = (logs: Array<{ outcome?: string }>) => logs.map((l) => l.outcome ?? "");

describe("web_if on a value", () => {
  it("holds when the value is not blank, and reads the store inline", async () => {
    const folderId = createFolder("outlook");
    createRecord(folderId, "nina@outlook.com", { connectedAt: "already here" });
    const { page } = fakePage();

    const result = await run(page, [
      {
        type: "web_if",
        check: "value",
        value: "{data.outlook[nina@outlook.com].connectedAt}",
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
      { type: "web_set", vars: [{ name: "savedMarker", value: "" }] },
      {
        type: "web_if",
        check: "value",
        value: "{savedMarker}",
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
