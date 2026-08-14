// The authenticator step inside a run: the code goes under a name the steps after it type,
// the secret comes out of the data store rather than the config, and a code with little of its
// window left is passed over in favour of the next one -- a login that has a Turnstile and a
// submit still ahead of it cannot afford to type one about to lapse.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { db } from "../db/database";
import { CF_TUNING_KEY } from "../jobs/cfTuning";
import { createFolder, createRecord } from "../db/dataStore";
import { runWebSteps } from "../jobs/cloudflare";
import { parseTotpSecret, totpCode } from "../jobs/totp";
import type { WebStep } from "../types";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/** Enough of a page for steps that never touch one; typing is recorded so the code is visible. */
function fakePage() {
  const typed: Array<{ selector: string; text: string }> = [];
  const page = {
    title: async () => "",
    url: () => "https://forum.example/signIn.html",
    screenshot: async () => Buffer.from("a jpeg, near enough"),
    keyboard: {
      press: async () => {},
      type: async (text: string) => typed.push({ selector: "", text }),
    },
    mouse: {
      move: async () => {},
      click: async () => {},
      down: async () => {},
      up: async () => {},
    },
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

const run = (page: Page, steps: WebStep[]) => runWebSteps(page, steps, Date.now() + 60_000, {});

process.env.DATA_MANAGEMENT = "1";

beforeEach(() => {
  vi.useRealTimers();
  db.prepare("DELETE FROM data_records").run();
  db.prepare("DELETE FROM data_folders").run();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('data_store_enabled','true')",
  ).run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    CF_TUNING_KEY,
    JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0, readyPollMs: 100 }),
  );
  const folderId = createFolder("example");
  createRecord(folderId, "133", {
    username: "someone",
    otp: `otpauth://totp/Example:someone?secret=${SECRET}&issuer=Example`,
  });
});

describe("web_totp", () => {
  it("types the code the authenticator would be showing, read out of the store", async () => {
    // Pinned mid-window, so the step has no reason to wait and the code is the one below
    vi.useFakeTimers({ shouldAdvanceTime: true, now: 300_000 - 15_000 });
    const { page, typed } = fakePage();
    const result = await run(page, [
      { type: "web_totp", secretRef: "{data.example.133.otp}", varName: "otp" },
      { type: "web_input", selector: "#stacked-otp", text: "{otp}" },
    ]);

    expect(result.ok).toBe(true);
    const expected = totpCode(parseTotpSecret(SECRET), Date.now());
    expect(typed.map((entry) => entry.text)).toEqual([expected]);
    expect(result.logs[0].outcome).toContain(`{otp} = ${expected}`);
    // The seed is the second factor itself, so it never reaches the run log
    expect(result.logs[0].outcome).not.toContain(SECRET);
  });

  it("waits for the next window when the code in hand is about to lapse", async () => {
    // 2s before the turnover, so the default 10s margin is not met
    vi.useFakeTimers({ shouldAdvanceTime: true, now: 300_000 - 2_000 });
    const { page, typed } = fakePage();
    const result = await run(page, [
      { type: "web_totp", secretRef: `${SECRET}`, varName: "otp" },
      { type: "web_input", selector: "#stacked-otp", text: "{otp}" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.logs[0].outcome).toContain("waited");
    // The code handed on is the window the wait crossed into, not the one that was lapsing
    expect(typed[0].text).toBe(totpCode(parseTotpSecret(SECRET), 300_000));
  });

  it("hands on whatever the window is showing when told not to wait", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: 300_000 - 2_000 });
    const { page } = fakePage();
    const result = await run(page, [
      { type: "web_totp", secretRef: SECRET, varName: "otp", minValidMs: 0 },
    ]);

    expect(result.ok).toBe(true);
    expect(result.logs[0].outcome).not.toContain("waited");
    expect(result.logs[0].outcome).toContain("good for another 2s");
  });

  it("fails the step when the store holds no secret to work from", async () => {
    const { page } = fakePage();
    const result = await run(page, [
      { type: "web_totp", secretRef: "{data.example.999.otp}", varName: "otp" },
    ]);

    expect(result.ok).toBe(false);
    // The unresolved reference is left as it stands, which is not a secret either
    expect(result.logs[0].error).toMatch(/base32|otpauth/);
  });

  it("needs a name to hold the code under", async () => {
    const { page } = fakePage();
    const result = await run(page, [{ type: "web_totp", secretRef: SECRET, varName: " " }]);

    expect(result.ok).toBe(false);
    expect(result.logs[0].error).toContain("no name given");
  });
});

/**
 * The setup page as the scan sees it: `innerText` first, then every attribute value. The real
 * step builds this list in the page; here it is handed over, so what is under test is the
 * picking and what the step does with it.
 */
function setupPage(candidates: string[]) {
  const page = {
    title: async () => "",
    url: () => "https://forum.example/setting",
    screenshot: async () => Buffer.from("a jpeg, near enough"),
    keyboard: { press: async () => {}, type: async () => {} },
    mouse: { move: async () => {}, click: async () => {}, down: async () => {}, up: async () => {} },
    evaluate: async (fn: unknown, arg?: unknown) => {
      const body = String(fn);
      // The scan is the one that walks attributes; everything else gets the usual stand-ins
      if (body.includes("attributes")) return candidates;
      if (typeof arg === "string") {
        if (body.includes("getBoundingClientRect")) return true;
        return "";
      }
      if (body.includes("challenge-")) return false;
      return "a page with plenty of readable text on it";
    },
    fill: async () => {},
    type: async () => {},
  };
  return page as unknown as Page;
}

describe("web_otp_secret", () => {
  const URL_SECRET = `otpauth://totp/Example:someone?secret=${SECRET}&issuer=Example`;

  it("takes the otpauth URL out of a QR image's address, masked in the log", async () => {
    const qrSrc = `https://qr.example/?size=180&data=${encodeURIComponent(URL_SECRET)}`;
    // Both copies, as the scan itself supplies: the attribute as written, then url-decoded
    const page = setupPage([
      "Scan this with your authenticator app",
      qrSrc,
      decodeURIComponent(qrSrc),
    ]);
    const result = await run(page, [{ type: "web_otp_secret", varName: "otpUrl" }]);

    expect(result.ok).toBe(true);
    expect(result.logs[0].outcome).toContain("{otpUrl} = otpauth://totp/Example:someone?secret=…");
    expect(result.logs[0].outcome).not.toContain(SECRET);
  });

  it("hands what it found to the code step, so enrolment can be confirmed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: 300_000 - 15_000 });
    const page = setupPage([`Cannot scan? Enter this instead: ${SECRET}`]);
    const result = await run(page, [
      { type: "web_otp_secret", varName: "otpUrl" },
      { type: "web_totp", secretRef: "{otpUrl}", varName: "otp" },
    ]);

    expect(result.ok).toBe(true);
    const expected = totpCode(parseTotpSecret(SECRET), Date.now());
    expect(result.logs[1].outcome).toContain(`{otp} = ${expected}`);
  });

  it("finds the secret a page put in a field for backing up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: 300_000 - 15_000 });
    // Grouped in fours, in a readonly box beside the QR: the page scan hands over each field's
    // live value for exactly this, since the markup itself carries no such thing
    const page = setupPage(["Scan the QR, or back up this secret", "GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ"]);
    const result = await run(page, [
      { type: "web_otp_secret", varName: "otpUrl" },
      { type: "web_totp", secretRef: "{otpUrl}", varName: "otp" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.logs[1].outcome).toContain(totpCode(parseTotpSecret(SECRET), Date.now()));
  });

  it("fails rather than carrying on when the page shows no secret", async () => {
    const page = setupPage(["Two-factor authentication is already on", "btn btn-primary"]);
    const result = await run(page, [
      { type: "web_otp_secret", varName: "otpUrl", waitMs: 300 },
    ]);

    expect(result.ok).toBe(false);
    expect(result.logs[0].error).toContain("no authenticator secret is on the page");
  });

  it("needs a name to hold the secret under", async () => {
    const page = setupPage([URL_SECRET]);
    const result = await run(page, [{ type: "web_otp_secret", varName: "" }]);

    expect(result.ok).toBe(false);
    expect(result.logs[0].error).toContain("no name given");
  });
});
