// The `web_email_link` step: what the executor asks the mailbox for, and what it does with
// the link that comes back -- which is a `web_goto` away from being the whole of a signup
// that verifies by link rather than by code.
//
// The mailbox is a stub, as it is for the code step. The link extraction itself is covered
// in emailLink.test.ts.
vi.mock("../db/database", () => ({
  db: {
    prepare: () => ({
      get: () => ({
        value: JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0, readyPollMs: 100 }),
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

/** Enough of a page for the steps here: navigation always lands. */
function fakePage() {
  const went: string[] = [];
  const page = {
    title: async () => "",
    url: () => went[went.length - 1] ?? "https://signup.example/",
    screenshot: async () => Buffer.from("a jpeg, near enough"),
    keyboard: { press: async () => {}, type: async () => {} },
    mouse: { move: async () => {}, click: async () => {}, down: async () => {}, up: async () => {} },
    evaluate: async (fn: unknown) => {
      const body = String(fn);
      if (body.includes("challenge-")) return false;
      return "a page with plenty of readable text on it";
    },
    goto: async (url: string) => {
      went.push(url);
      return null;
    },
  };
  return { page: page as unknown as Page, went };
}

const run = (page: Page, steps: WebStep[], hooks: Parameters<typeof runWebSteps>[3] = {}) =>
  runWebSteps(page, steps, Date.now() + 30_000, hooks);

const STEP: WebStep = {
  type: "web_email_link",
  email: "pool7@outlook.com",
  poolType: "cloudflare",
  varName: "verifyLink",
  fromContains: "cloudflare",
  subjectContains: "verify your email",
  urlContains: "email-verification",
  waitMs: 5_000,
};

const VERIFY_URL = "https://dash.cloudflare.com/email-verification?token=abc123";

const found = async () => ({
  url: VERIFY_URL,
  subject: "[Action required] Verify your email address",
  from: "noreply@notify.cloudflare.com",
  mailbox: "INBOX",
});

describe("web_email_link", () => {
  it("holds the link under the name it was given", async () => {
    const f = fakePage();
    const out = await run(f.page, [STEP], { emailLink: found });

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toContain("{verifyLink} = https://dash.cloudflare.com");
    expect(out.logs[0].outcome).toContain("noreply@notify.cloudflare.com");
  });

  it("hands the pool type and every filter on", async () => {
    const f = fakePage();
    const seen: any[] = [];
    await run(f.page, [STEP], {
      emailLink: async (q) => {
        seen.push(q);
        return found();
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      email: "pool7@outlook.com",
      poolType: "cloudflare",
      fromContains: "cloudflare",
      subjectContains: "verify your email",
      urlContains: "email-verification",
    });
  });

  it("lets a later step open it as {name}", async () => {
    const f = fakePage();
    const out = await run(
      f.page,
      [STEP, { type: "web_goto", url: "{verifyLink}", waitMs: 5_000 }],
      { emailLink: found },
    );

    expect(out.ok).toBe(true);
    expect(f.went).toContain(VERIFY_URL);
  });

  it("fills the mailbox from the round's own names", async () => {
    const f = fakePage();
    const seen: any[] = [];
    await run(
      f.page,
      [
        { type: "web_set", varName: "email", value: "leased@outlook.com" },
        { ...STEP, email: "{email}", subjectContains: "" } as WebStep,
      ],
      {
        emailLink: async (q) => {
          seen.push(q);
          return found();
        },
      },
    );

    expect(seen[0].email).toBe("leased@outlook.com");
    expect(seen[0].subjectContains).toBeUndefined();
  });

  it("never waits past the time left for the action", async () => {
    const f = fakePage();
    const seen: any[] = [];
    await runWebSteps(f.page, [{ ...STEP, waitMs: 600_000 } as WebStep], Date.now() + 20_000, {
      emailLink: async (q) => {
        seen.push(q);
        return found();
      },
    });

    expect(seen[0].waitMs).toBeLessThanOrEqual(20_000);
  });

  it("says which mailbox it was in when the mail was filed as junk", async () => {
    const f = fakePage();
    const out = await run(f.page, [STEP], {
      emailLink: async () => ({ ...(await found()), mailbox: "Junk" }),
    });

    expect(out.logs[0].outcome).toContain("in Junk");
  });

  it("fails, with the mailbox named, when no matching link arrives", async () => {
    const f = fakePage();
    const out = await run(f.page, [STEP], { emailLink: async () => null });

    expect(out.ok).toBe(false);
    expect(out.failure).toContain("pool7@outlook.com");
    expect(out.logs[0].error).toMatch(/no matching link/);
  });

  it("carries the reason up when the mailbox itself refuses", async () => {
    const f = fakePage();
    const out = await run(f.page, [STEP], {
      emailLink: async () => {
        throw new Error("msOauth2api: Refresh token failed (3 tries)");
      },
    });

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toContain("Refresh token failed");
  });

  it("says so where reading a mailbox is not available", async () => {
    const f = fakePage();
    const out = await run(f.page, [STEP], {});

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/not available here/);
  });

  it("refuses a step with no name to hold the link under", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ ...STEP, varName: "" } as WebStep], { emailLink: found });

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/no name given/);
  });

  it("refuses a step with no mailbox to read", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ ...STEP, email: "" } as WebStep], { emailLink: found });

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/no mailbox given/);
  });
});
