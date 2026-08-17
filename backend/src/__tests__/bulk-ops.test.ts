// Unit tests for the background bulk operations (jobs/bulkOps.ts) and the shared
// per-account operations they are built from (jobs/accountOps.ts). Telegram is
// mocked at the leaf modules, so the composition each bulk action performs --
// order of calls, bookkeeping, per-item results -- is what gets exercised.

import Database from "better-sqlite3";

let testDb!: InstanceType<typeof Database>;
let defaultCreds: { apiId: number; apiHash: string } | null = {
  apiId: 1,
  apiHash: "global-hash",
};

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
  getDefaultTgApiCredentials: () => defaultCreds,
}));

// vi.mock factories are hoisted, so the spies they hand back are built here
const mocks = vi.hoisted(() => ({
  tg: {
    checkAccountStatus: vi.fn(),
    getPasswordInfo: vi.fn(),
    getPasskeys: vi.fn(),
    registerPasskey: vi.fn(),
    deletePasskey: vi.fn(),
    getSessionDc: vi.fn(() => ({ dcId: 2 })),
    terminateOtherSessions: vi.fn(),
    updateTwoFa: vi.fn(),
    verifyPasskeyLogin: vi.fn(),
  },
  live: {
    cleanAccount: vi.fn(),
    getLiveClient: vi.fn(async () => ({})),
    isAuthError: vi.fn(() => false),
    markSessionExpired: vi.fn(),
    syncDialogsInBackground: vi.fn(async () => undefined),
  },
  checkSpamStatus: vi.fn(),
  changeLoginEmailViaGmail: vi.fn(),
  startManualJobRun: vi.fn(),
  cancelJob: vi.fn(() => true),
}));

const { tg, live, checkSpamStatus, changeLoginEmailViaGmail, startManualJobRun } = mocks;

vi.mock("../auth/tgAuth", () => mocks.tg);
vi.mock("../tg/liveClient", () => mocks.live);
vi.mock("../jobs/checkin", () => ({
  checkSpamStatus: mocks.checkSpamStatus,
  expandCommand: (s: string) => s,
}));
vi.mock("../jobs/bulkLoginEmail", () => ({
  changeLoginEmailViaGmail: mocks.changeLoginEmailViaGmail,
  testGmailImap: vi.fn(),
}));
vi.mock("../jobs/manualRun", () => ({ startManualJobRun: mocks.startManualJobRun }));
vi.mock("../jobs/cancellation", () => ({
  cancelJob: mocks.cancelJob,
  registerJob: vi.fn(),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock("../tg/appClient", () => ({
  resolveAppClientParams: vi.fn(() => ({ deviceModel: "PC 64bit" })),
  previewDeviceModel: vi.fn(() => "PC 64bit"),
}));
vi.mock("../jobs/runner", () => ({
  runJob: vi.fn(),
  parseTgProxy: vi.fn((url?: string) => (url ? { ip: url } : undefined)),
}));

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import {
  startBulkClean,
  startBulkCredentials,
  startBulkFetchAttributes,
  startBulkJobRuns,
  startBulkLoginEmail,
  startBulkPasskey,
  startBulkSpamCheck,
} from "../jobs/bulkOps";
import {
  accountOpContext,
  accountHasPasskeyFlag,
  appendAccountNotes,
  resolveProxyUrl,
} from "../jobs/accountOps";
import { parseTgProxy } from "../jobs/runner";
import {
  getBulkTask,
  resetBulkTasks,
  type BulkTask,
  type StartBulkTaskResult,
} from "../jobs/bulkTasks";
import { savePasskeySecret } from "../tg/passkeyStore";

const SCHEMA = `
  CREATE TABLE tg_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL DEFAULT '',
    phone_number    TEXT    NOT NULL DEFAULT '',
    api_id          INTEGER,
    api_hash        TEXT,
    session_string  TEXT,
    auth_status     TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    disabled        INTEGER NOT NULL DEFAULT 0,
    proxy_id        TEXT,
    app_client_id   TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    tg_display_name TEXT,
    tg_username     TEXT,
    notes           TEXT,
    passkey         TEXT,
    additional_attributes TEXT
  );
  CREATE TABLE jobs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL DEFAULT 'Job',
    job_type TEXT NOT NULL DEFAULT 'checkin'
  );
  CREATE TABLE job_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  INTEGER NOT NULL,
    status  TEXT    NOT NULL,
    message TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function addAccount(
  name: string,
  opts: { authenticated?: boolean; notes?: string; apiId?: number | null } = {},
): number {
  const { lastInsertRowid } = testDb
    .prepare(
      `INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status, notes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      `+6140000000${name.slice(-1)}`,
      opts.apiId === undefined ? 111 : opts.apiId,
      opts.apiId === null ? null : "own-hash",
      opts.authenticated === false ? null : "session",
      opts.authenticated === false ? "unauthenticated" : "authenticated",
      opts.notes ?? null,
      1,
    );
  return Number(lastInsertRowid);
}

function addJob(name: string): number {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO jobs (name) VALUES (?)")
    .run(name);
  return Number(lastInsertRowid);
}

/** Unwraps a start result, failing the test when the task was refused. */
function task(result: StartBulkTaskResult): BulkTask {
  if (!result.ok) throw new Error(`task refused: ${result.error}`);
  return result.task;
}

async function settle(t: BulkTask, timeoutMs = 3000): Promise<BulkTask> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getBulkTask(t.id)?.state !== "running") return getBulkTask(t.id)!;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("task did not finish");
}

function attributes(accountId: number): Record<string, unknown> {
  const row = testDb
    .prepare("SELECT additional_attributes FROM tg_accounts WHERE id = ?")
    .get(accountId) as { additional_attributes: string | null };
  return row.additional_attributes ? JSON.parse(row.additional_attributes) : {};
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  vi.clearAllMocks();
  resetBulkTasks();
  defaultCreds = { apiId: 1, apiHash: "global-hash" };
  testDb.exec("DELETE FROM tg_accounts; DELETE FROM jobs; DELETE FROM job_logs; DELETE FROM settings;");
  tg.getSessionDc.mockReturnValue({ dcId: 2 });
  live.isAuthError.mockReturnValue(false);
});

// ── accountOps ───────────────────────────────────────────────────────────────

describe("accountOpContext", () => {
  it("resolves the account's own credential pair over the global default", () => {
    const id = addAccount("A_1");
    const ctx = accountOpContext(id);
    expect(ctx.apiId).toBe(111);
    expect(ctx.apiHash).toBe("own-hash");
    expect(ctx.deviceParams).toEqual({ deviceModel: "PC 64bit" });
  });

  it("falls back to the global default pair when the account has none", () => {
    const id = addAccount("A_2", { apiId: null });
    const ctx = accountOpContext(id);
    expect(ctx.apiId).toBe(1);
    expect(ctx.apiHash).toBe("global-hash");
  });

  it("refuses a missing account, a dead session, and missing credentials", () => {
    expect(() => accountOpContext(9999)).toThrow(/not found/i);
    const dead = addAccount("A_3", { authenticated: false });
    expect(() => accountOpContext(dead)).toThrow(/not authenticated/i);
    defaultCreds = null;
    const noCreds = addAccount("A_4", { apiId: null });
    expect(() => accountOpContext(noCreds)).toThrow(/No API credentials/);
  });

  it("resolves the proxy url from the settings list, ignoring unknown ids", () => {
    testDb
      .prepare("INSERT INTO settings (key, value) VALUES ('proxies', ?)")
      .run(JSON.stringify([{ id: "p1", url: "socks5://host:1080" }]));
    expect(resolveProxyUrl("p1")).toBe("socks5://host:1080");
    expect(resolveProxyUrl("nope")).toBeUndefined();
    expect(resolveProxyUrl(null)).toBeUndefined();
  });
});

// An account whose proxy cannot be resolved used to connect direct with nothing said, which
// puts every such account on the server's own address -- the thing Telegram answers by
// dropping login-email codes after the first.
describe("account exit", () => {
  const setProxy = (accountId: number, proxyId: string | null) =>
    testDb
      .prepare("UPDATE tg_accounts SET proxy_id = ? WHERE id = ?")
      .run(proxyId, accountId);

  it("reads as direct when the account names no proxy", () => {
    expect(accountOpContext(addAccount("A_1")).exit).toBe("direct");
  });

  it("refuses an account whose proxy is no longer configured", () => {
    const id = addAccount("A_1");
    setProxy(id, "gone");
    expect(() => accountOpContext(id)).toThrow(/not configured on this server/);
  });

  it("refuses an account whose proxy cannot carry Telegram", () => {
    const id = addAccount("A_1");
    setProxy(id, "p1");
    testDb
      .prepare("INSERT INTO settings (key, value) VALUES ('proxies', ?)")
      .run(JSON.stringify([{ id: "p1", url: "http://host:8080" }]));
    vi.mocked(parseTgProxy).mockReturnValueOnce(undefined);
    expect(() => accountOpContext(id)).toThrow(/socks5/);
  });

  it("labels a usable proxy by host and port", () => {
    const id = addAccount("A_1");
    setProxy(id, "p1");
    testDb
      .prepare("INSERT INTO settings (key, value) VALUES ('proxies', ?)")
      .run(JSON.stringify([{ id: "p1", url: "socks5://host:1080" }]));
    vi.mocked(parseTgProxy).mockReturnValueOnce({
      ip: "1.2.3.4",
      port: 1080,
      socksType: 5,
    });
    expect(accountOpContext(id).exit).toBe("1.2.3.4:1080");
  });
});

describe("appendAccountNotes", () => {
  it("appends on a new line and starts fresh when there are no notes", () => {
    const withNotes = addAccount("A_1", { notes: "first" });
    const without = addAccount("A_2");
    appendAccountNotes(withNotes, "second");
    appendAccountNotes(without, "only");
    const read = (id: number) =>
      (testDb.prepare("SELECT notes FROM tg_accounts WHERE id = ?").get(id) as any).notes;
    expect(read(withNotes)).toBe("first\nsecond");
    expect(read(without)).toBe("only");
  });
});

// ── Target selection, shared by every account bulk action ────────────────────

describe("target selection", () => {
  it("keeps only authenticated accounts, in list order, without duplicates", async () => {
    const a = addAccount("A_1");
    addAccount("A_2", { authenticated: false });
    const c = addAccount("A_3");
    checkSpamStatus.mockResolvedValue({ spamStatus: "free", rawMessage: "" });

    const t = task(startBulkSpamCheck([c, a, a, 9999], 0));
    expect(t.items.map((i) => i.refId)).toEqual([a, c]);
    await settle(t);
  });

  it("refuses when the selection holds nothing usable", () => {
    addAccount("A_1", { authenticated: false });
    expect(startBulkSpamCheck([1, 2, 3], 0)).toEqual({
      ok: false,
      error: "No authenticated accounts in the selection",
    });
  });

  it("refuses a credential change with no new password", () => {
    addAccount("A_1");
    expect(startBulkCredentials([1], { newPassword: "" }, 0)).toEqual({
      ok: false,
      error: "newPassword is required",
    });
  });
});

// ── Spam check ───────────────────────────────────────────────────────────────

describe("bulk spam check", () => {
  it("persists a restriction and clears it once the account reads free", async () => {
    const limited = addAccount("A_1");
    const free = addAccount("A_2");
    checkSpamStatus
      .mockResolvedValueOnce({ spamStatus: "limited", rawMessage: "restricted" })
      .mockResolvedValueOnce({ spamStatus: "free", rawMessage: "good news" });

    const done = await settle(task(startBulkSpamCheck([limited, free], 0)));
    expect(done.items.map((i) => i.data?.spamStatus)).toEqual(["limited", "free"]);
    expect(attributes(limited).restriction).toBe("limited");
    expect(attributes(free).restriction).toBeUndefined();
  });

  it("leaves an existing restriction alone on an unknown result", async () => {
    const id = addAccount("A_1");
    checkSpamStatus.mockResolvedValueOnce({ spamStatus: "blocked", rawMessage: "" });
    await settle(task(startBulkSpamCheck([id], 0)));
    checkSpamStatus.mockResolvedValueOnce({ spamStatus: "unknown", rawMessage: "" });
    await settle(task(startBulkSpamCheck([id], 0)));
    expect(attributes(id).restriction).toBe("blocked");
  });

  it("marks the session expired when Telegram says the session is gone", async () => {
    const id = addAccount("A_1");
    live.isAuthError.mockReturnValue(true);
    checkSpamStatus.mockRejectedValue(new Error("AUTH_KEY_UNREGISTERED"));

    const done = await settle(task(startBulkSpamCheck([id], 0)));
    expect(done.items[0].status).toBe("failed");
    expect(live.markSessionExpired).toHaveBeenCalledWith(id);
  });
});

// ── Fetch attributes ─────────────────────────────────────────────────────────

describe("bulk fetch attributes", () => {
  it("stores the TG meta, hasEmail and hasPasskey flags", async () => {
    const id = addAccount("A_1");
    tg.checkAccountStatus.mockResolvedValue({
      firstName: "Jane",
      lastName: "Doe",
      username: "jane",
      restrictions: [],
    });
    tg.getPasswordInfo.mockResolvedValue({ loginEmailPattern: "j***@gmail.com" });
    tg.getPasskeys.mockResolvedValue([{ id: "pk1" }]);

    const done = await settle(task(startBulkFetchAttributes([id], 0)));
    expect(done.items[0].status).toBe("done");
    expect(done.items[0].data?.warnings).toEqual([]);
    const row = testDb
      .prepare("SELECT tg_display_name, tg_username FROM tg_accounts WHERE id = ?")
      .get(id) as any;
    expect(row.tg_display_name).toBe("Jane Doe");
    expect(row.tg_username).toBe("jane");
    expect(attributes(id)).toMatchObject({ hasEmail: true, hasPasskey: true });
  });

  it("keeps going after one step fails and reports it as a warning", async () => {
    const id = addAccount("A_1");
    tg.checkAccountStatus.mockResolvedValue({
      firstName: "Jane",
      lastName: "",
      username: undefined,
      restrictions: [],
    });
    tg.getPasswordInfo.mockRejectedValue(new Error("password-info boom"));
    tg.getPasskeys.mockResolvedValue([]);

    const done = await settle(task(startBulkFetchAttributes([id], 0)));
    expect(done.items[0].status).toBe("done");
    expect(done.items[0].data?.warnings).toEqual(["password-info: password-info boom"]);
    // The later step still ran
    expect(tg.getPasskeys).toHaveBeenCalledTimes(1);
  });

  it("stops the remaining steps once the session is known dead", async () => {
    const id = addAccount("A_1");
    live.isAuthError.mockReturnValue(true);
    tg.checkAccountStatus.mockRejectedValue(new Error("AUTH_KEY_UNREGISTERED"));

    const done = await settle(task(startBulkFetchAttributes([id], 0)));
    expect(done.items[0].data?.authExpired).toBe(true);
    expect(tg.getPasswordInfo).not.toHaveBeenCalled();
    expect(tg.getPasskeys).not.toHaveBeenCalled();
  });
});

// ── Credential change ────────────────────────────────────────────────────────

describe("bulk credential change", () => {
  it("changes 2FA, removes devices and foreign passkeys, re-adds Bemby's, appends notes", async () => {
    const id = addAccount("A_1", { notes: "existing" });
    savePasskeySecret({
      accountId: id,
      telegramPasskeyId: "pk-bemby",
      credentialId: "cred",
      privateKeyPem: "pem",
      rpId: "web.telegram.org",
      userHandle: "handle",
      createdDate: 1,
      dcId: 2,
    });
    testDb
      .prepare("UPDATE tg_accounts SET additional_attributes = ? WHERE id = ?")
      .run(JSON.stringify({ hasPasskey: true }), id);
    // The 2FA change dropped every passkey on Telegram's side
    tg.getPasskeys.mockResolvedValue([{ id: "pk-foreign" }]);
    tg.deletePasskey.mockResolvedValue(true);
    tg.registerPasskey.mockResolvedValue({
      passkey: { id: "pk-new", date: 7 },
      credentialId: "cred2",
      privateKeyPem: "pem2",
      rpId: "web.telegram.org",
      userHandle: "handle2",
    });

    const done = await settle(
      task(
        startBulkCredentials(
          [id],
          {
            currentPassword: "old",
            newPassword: "new",
            removeDevices: true,
            removePasskeys: true,
            notesAppend: "rotated",
          },
          0,
        ),
      ),
    );

    expect(tg.updateTwoFa).toHaveBeenCalledWith(
      111,
      "own-hash",
      "session",
      { currentPassword: "old", newPassword: "new" },
      undefined,
      { deviceModel: "PC 64bit" },
    );
    expect(tg.terminateOtherSessions).toHaveBeenCalledTimes(1);
    // The stored (Bemby) passkey is kept; the foreign one is revoked
    expect(tg.deletePasskey.mock.calls.map((c) => c[3])).toEqual(["pk-foreign"]);
    expect(tg.registerPasskey).toHaveBeenCalledTimes(1);
    expect(done.items[0].status).toBe("done");
    expect(done.items[0].data).toEqual({
      twoFaChanged: true,
      devicesRemoved: true,
      passkeysRemoved: 1,
      passkeyReadded: true,
      notesUpdated: true,
    });
    const notes = (
      testDb.prepare("SELECT notes FROM tg_accounts WHERE id = ?").get(id) as any
    ).notes;
    expect(notes).toBe("existing\nrotated");
  });

  it("touches nothing beyond the password when no extras are asked for", async () => {
    const id = addAccount("A_1");
    const done = await settle(
      task(startBulkCredentials([id], { newPassword: "new" }, 0)),
    );
    expect(tg.updateTwoFa).toHaveBeenCalledTimes(1);
    expect(tg.terminateOtherSessions).not.toHaveBeenCalled();
    expect(tg.getPasskeys).not.toHaveBeenCalled();
    expect(done.items[0].data).toEqual({ twoFaChanged: true });
  });

  it("fails the item and skips the extras when the password change is refused", async () => {
    const id = addAccount("A_1");
    tg.updateTwoFa.mockRejectedValueOnce(new Error("PASSWORD_HASH_INVALID"));
    const done = await settle(
      task(
        startBulkCredentials([id], { newPassword: "new", removeDevices: true }, 0),
      ),
    );
    expect(done.items[0].status).toBe("failed");
    expect(done.items[0].error).toBe("PASSWORD_HASH_INVALID");
    expect(tg.terminateOtherSessions).not.toHaveBeenCalled();
  });

  it("keeps the new password out of the task the panel polls", async () => {
    const id = addAccount("A_1");
    const done = await settle(
      task(startBulkCredentials([id], { newPassword: "top-secret" }, 0)),
    );
    expect(JSON.stringify(done)).not.toContain("top-secret");
  });
});

// ── Passkey ──────────────────────────────────────────────────────────────────

describe("bulk add passkey", () => {
  it("registers one when the account has none stored", async () => {
    const id = addAccount("A_1");
    tg.getPasskeys.mockResolvedValue([]);
    tg.registerPasskey.mockResolvedValue({
      passkey: { id: "pk-new", date: 7 },
      credentialId: "cred",
      privateKeyPem: "pem",
      rpId: "web.telegram.org",
      userHandle: "handle",
    });

    const done = await settle(task(startBulkPasskey([id], 0)));
    expect(done.items[0].data).toEqual({ action: "added" });
    expect(attributes(id).hasPasskey).toBe(true);
  });

  it("verifies an existing stored passkey instead of adding another", async () => {
    const id = addAccount("A_1");
    savePasskeySecret({
      accountId: id,
      telegramPasskeyId: "pk1",
      credentialId: "cred",
      privateKeyPem: "pem",
      rpId: "web.telegram.org",
      userHandle: "handle",
      createdDate: 1,
      dcId: 2,
    });
    tg.getPasskeys.mockResolvedValue([{ id: "pk1" }]);
    tg.verifyPasskeyLogin.mockResolvedValue({ ok: true });

    const done = await settle(task(startBulkPasskey([id], 0)));
    expect(done.items[0].data).toEqual({ action: "skippedValid" });
    expect(tg.registerPasskey).not.toHaveBeenCalled();
  });

  it("fails the item when the stored passkey no longer logs in", async () => {
    const id = addAccount("A_1");
    savePasskeySecret({
      accountId: id,
      telegramPasskeyId: "pk1",
      credentialId: "cred",
      privateKeyPem: "pem",
      rpId: "web.telegram.org",
      userHandle: "handle",
      createdDate: 1,
      dcId: 2,
    });
    tg.getPasskeys.mockResolvedValue([{ id: "pk1" }]);
    tg.verifyPasskeyLogin.mockResolvedValue({ ok: false });

    const done = await settle(task(startBulkPasskey([id], 0)));
    expect(done.items[0].status).toBe("failed");
    expect(done.items[0].error).toMatch(/not usable/);
  });

  it("drops stored keys Telegram no longer knows about", async () => {
    const id = addAccount("A_1");
    savePasskeySecret({
      accountId: id,
      telegramPasskeyId: "pk-gone",
      credentialId: "cred",
      privateKeyPem: "pem",
      rpId: "web.telegram.org",
      userHandle: "handle",
      createdDate: 1,
      dcId: 2,
    });
    // Telegram lists nothing, so the stale stored key is pruned and one is added
    tg.getPasskeys.mockResolvedValue([]);
    tg.registerPasskey.mockResolvedValue({
      passkey: { id: "pk-new", date: 7 },
      credentialId: "cred2",
      privateKeyPem: "pem2",
      rpId: "web.telegram.org",
      userHandle: "handle2",
    });

    const done = await settle(task(startBulkPasskey([id], 0)));
    expect(done.items[0].data).toEqual({ action: "added" });
    expect(accountHasPasskeyFlag(id)).toBe(true);
  });
});

// ── Login email ──────────────────────────────────────────────────────────────

describe("bulk login email change", () => {
  it("passes the Gmail details through and reports the address it set", async () => {
    const id = addAccount("A_1");
    changeLoginEmailViaGmail.mockResolvedValue({ email: "me+abcd@gmail.com" });

    const done = await settle(
      task(
        startBulkLoginEmail(
          [id],
          { gmail: "me@gmail.com", appPassword: "app-pw", tag: "{phoneNum}" },
          0,
        ),
      ),
    );
    expect(changeLoginEmailViaGmail).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: id,
        gmail: "me@gmail.com",
        appPassword: "app-pw",
        tag: "{phoneNum}",
        sessionString: "session",
      }),
    );
    expect(done.items[0].message).toBe("me+abcd@gmail.com");
    expect(JSON.stringify(done)).not.toContain("app-pw");
  });

  it("records the exit each change went out by", async () => {
    const id = addAccount("A_1");
    changeLoginEmailViaGmail.mockResolvedValue({ email: "me+abcd@gmail.com" });

    const done = await settle(
      task(
        startBulkLoginEmail(
          [id],
          { gmail: "me@gmail.com", appPassword: "app-pw", tag: "" },
          0,
        ),
      ),
    );
    expect(done.items[0].data).toEqual({
      email: "me+abcd@gmail.com",
      exit: "direct",
    });
  });
});

// ── Clean ────────────────────────────────────────────────────────────────────

describe("bulk clean", () => {
  it("reports the per-account counts and resyncs dialogs", async () => {
    const id = addAccount("A_1");
    live.cleanAccount.mockResolvedValue({
      left: 3,
      deleted: 4,
      contacts: 5,
      folders: 6,
      failed: ["x"],
    });

    const done = await settle(task(startBulkClean([id], 0)));
    expect(done.items[0].data).toEqual({
      left: 3,
      deleted: 4,
      contacts: 5,
      folders: 6,
      failed: ["x"],
    });
    expect(live.syncDialogsInBackground).toHaveBeenCalledWith(id);
  });
});

// ── Job runs ─────────────────────────────────────────────────────────────────

describe("bulk job runs", () => {
  it("runs each job to completion and reports the log outcome", async () => {
    const a = addJob("Job A");
    const b = addJob("Job B");
    let logId = 0;
    startManualJobRun.mockImplementation((jobId: number) => {
      logId += 1;
      const id = logId;
      testDb
        .prepare("INSERT INTO job_logs (id, job_id, status, message) VALUES (?, ?, 'running', '')")
        .run(id, jobId);
      return {
        ok: true,
        logId: id,
        completion: (async () => {
          testDb
            .prepare("UPDATE job_logs SET status = 'success', message = 'Completed' WHERE id = ?")
            .run(id);
        })(),
      };
    });

    const done = await settle(task(startBulkJobRuns([a, b], 0)));
    expect(startManualJobRun.mock.calls.map((c) => c[0])).toEqual([a, b]);
    expect(done.items.map((i) => i.status)).toEqual(["done", "done"]);
    expect(done.items[0].message).toBe("Completed");
  });

  it("fails the item when the run cannot start, and carries on", async () => {
    const a = addJob("Job A");
    const b = addJob("Job B");
    startManualJobRun
      .mockReturnValueOnce({ ok: false, status: 400, error: "Account is not authenticated" })
      .mockImplementationOnce((jobId: number) => {
        testDb
          .prepare("INSERT INTO job_logs (id, job_id, status, message) VALUES (9, ?, 'success', 'ok')")
          .run(jobId);
        return { ok: true, logId: 9, completion: Promise.resolve() };
      });

    const done = await settle(task(startBulkJobRuns([a, b], 0)));
    expect(done.items[0].status).toBe("failed");
    expect(done.items[0].error).toBe("Account is not authenticated");
    expect(done.items[1].status).toBe("done");
  });

  it("terminates a run that outlives the ceiling and carries on with the queue", async () => {
    const a = addJob("Job A");
    const b = addJob("Job B");
    let logId = 0;
    startManualJobRun.mockImplementation((jobId: number) => {
      logId += 1;
      const id = logId;
      testDb
        .prepare("INSERT INTO job_logs (id, job_id, status, message) VALUES (?, ?, 'running', '')")
        .run(id, jobId);
      // The first run only ends when it is cancelled; the second finishes on its own
      if (id === 1) {
        return {
          ok: true,
          logId: id,
          completion: new Promise<void>((resolve) => {
            mocks.cancelJob.mockImplementation(() => {
              resolve();
              return true;
            });
          }),
        };
      }
      testDb.prepare("UPDATE job_logs SET status = 'success', message = 'Completed' WHERE id = ?").run(id);
      return { ok: true, logId: id, completion: Promise.resolve() };
    });

    const done = await settle(task(startBulkJobRuns([a, b], 0, 1)));
    expect(mocks.cancelJob).toHaveBeenCalledWith(1);
    expect(done.items[0].status).toBe("failed");
    expect(done.items[0].error).toBe("Run passed the 1s limit and was terminated");
    expect(done.items[1].status).toBe("done");
    // The row the run left open is settled rather than reading as still running
    expect(
      (testDb.prepare("SELECT status FROM job_logs WHERE id = 1").get() as { status: string }).status,
    ).toBe("failed");
  });

  it("reports a failed run with the log's own message", async () => {
    const a = addJob("Job A");
    startManualJobRun.mockImplementation((jobId: number) => {
      testDb
        .prepare("INSERT INTO job_logs (id, job_id, status, message) VALUES (5, ?, 'failed', 'bot never replied')")
        .run(jobId);
      return { ok: true, logId: 5, completion: Promise.resolve() };
    });

    const done = await settle(task(startBulkJobRuns([a], 0)));
    expect(done.items[0].status).toBe("failed");
    expect(done.items[0].error).toBe("bot never replied");
  });
});
