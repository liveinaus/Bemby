// Guards that a backup carries everything worth carrying. Runs against the real
// schema (built by db/database.ts) and the real route handlers, then asserts two
// things: every column of the exported tables is either in the payload or on an
// explicit "not applicable" list, and a full round-trip restores the values.
//
// The column sweep is the point: a column added later fails this test until it is
// either exported or deliberately excluded.

import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import express from "express";

// The real database module reads DB_PATH at import time
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bemby-export-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.BULK_ACCOUNT_MANAGEMENT = "1";
process.env.ADMIN_PASSWORD = "test-admin-pw";

vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));
vi.mock("../auth/tgAuth", () => ({
  requestCode: vi.fn(),
  submitCode: vi.fn(),
  submitPassword: vi.fn(),
  checkAccountStatus: vi.fn(),
  resendCodeAsSms: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  getSessions: vi.fn(),
  terminateSession: vi.fn(),
  getPasswordInfo: vi.fn(),
  sendLoginEmailCode: vi.fn(),
  verifyLoginEmail: vi.fn(),
  verifyPasskeyLogin: vi.fn(),
  startPasskeyLogin: vi.fn(),
  getSessionDc: vi.fn(() => ({ dcId: 2 })),
  getPasskeys: vi.fn(async () => []),
  registerPasskey: vi.fn(),
  deletePasskey: vi.fn(),
  updateTwoFa: vi.fn(),
  terminateOtherSessions: vi.fn(),
}));
vi.mock("../tg/liveClient", () => ({
  isAuthError: () => false,
  markSessionExpired: vi.fn(),
  cleanAccount: vi.fn(),
  getLiveClient: vi.fn(),
  syncDialogsInBackground: vi.fn(),
}));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn(), parseTgProxy: vi.fn() }));
vi.mock("../jobs/checkin", () => ({ checkSpamStatus: vi.fn(), expandCommand: (s: string) => s }));
vi.mock("../jobs/embywatch", () => ({ runEmbywatch: vi.fn(), testEmbyConnection: vi.fn() }));
vi.mock("../jobs/profileGen", () => ({ generateProfiles: vi.fn() }));

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

let server: http.Server | undefined;
let baseUrl = "";
let db!: import("better-sqlite3").Database;
let savePasskeySecret!: typeof import("../tg/passkeyStore").savePasskeySecret;

const SECRET = "backup-secret";

async function postJson(pathname: string, body: unknown) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** snake_case column name to the camelCase key a payload would use. */
function camel(column: string): string {
  return column.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function columnsOf(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

/**
 * Columns a backup deliberately leaves out.
 *  - id / created_at: identity of this install's row, reassigned on import
 *  - account_id / template_id: exported as array indices instead of raw ids
 *  - api_hash / session_string / passkey: carried, but under a different key
 *  - tg_avatar / tg_avatar_at: a cache of the profile photo, read again from Telegram
 */
const NOT_EXPORTED: Record<string, string[]> = {
  tg_accounts: ["id", "created_at", "tg_avatar", "tg_avatar_at"],
  jobs: ["id", "created_at", "account_id", "template_id"],
  job_templates: ["id", "created_at"],
};

function expectCoversEveryColumn(
  table: string,
  exported: Record<string, unknown>,
  extraKeyFor: Record<string, string> = {},
): void {
  const missing = columnsOf(table)
    .filter((c) => !NOT_EXPORTED[table].includes(c))
    .map((c) => ({ column: c, key: extraKeyFor[c] ?? camel(c) }))
    .filter(({ key }) => !(key in exported));
  expect(missing.map((m) => m.column)).toEqual([]);
}

function seed(): void {
  // Ids keep climbing across the wipe/seed cycles, so references are taken from
  // the inserts rather than assumed to be 1.
  const accountId = Number(
    db
      .prepare(
        `INSERT INTO tg_accounts
           (name, phone_number, api_id, api_hash, session_string, auth_status, proxy_id,
            disabled, app_client_id, sort_order, tg_display_name, tg_username, notes,
            additional_attributes)
         VALUES ('A_1', '+61400000001', 111, 'own-hash', 'session-1', 'authenticated', 'p1',
                 1, 'client-1', 7, 'Jane Doe', 'jane', 'bought 2026-01-02', ?)`,
      )
      .run(JSON.stringify({ hasEmail: true, restriction: "limited" })).lastInsertRowid,
  );
  const templateId = Number(
    db
      .prepare(
        `INSERT INTO job_templates
           (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, enabled,
            config, start_command, checkin_button, run_every_days, run_every_days_max)
         VALUES ('T_1', 'checkin', '@bot', 'Australia/Sydney', 41000, 4, 0,
                 '{"a":1}', '/go', 'sign', 3, 6)`,
      )
      .run().lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO jobs
       (name, account_id, template_id, job_type, bot_username, schedule_window_start,
        schedule_window_end, timezone, reply_timeout_ms, retry_max, enabled, config,
        start_command, checkin_button, run_every_days, run_every_days_max, retired,
        last_success_at)
     VALUES ('J_1', ?, ?, 'checkin', '@bot', 900, 1000, 'Australia/Perth', 42000, 6, 0,
             '{"b":2}', '/start2', 'sign2', 4, 9, '2026-07-01T00:00:00.000Z',
             '2026-07-02T00:00:00.000Z')`,
  ).run(accountId, templateId);
  const supplierId = Number(
    db
      .prepare(
        "INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES ('S', 'https://s', 'k', 1234)",
      )
      .run().lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO ai_models (supplier_id, model_id, label) VALUES (?, 'm', 'M')",
  ).run(supplierId);
  // The proxy the account points at must be configured on this instance, or the
  // import clears the reference by design (see clearUnknownProxyRefs).
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('proxies', ?)",
  ).run(JSON.stringify([{ id: "p1", url: "socks5://proxy:1080" }]));
  // A passkey secret lives on the account row and must survive the round-trip
  savePasskeySecret({
    accountId,
    telegramPasskeyId: "pk1",
    credentialId: "cred",
    privateKeyPem: "pem",
    rpId: "web.telegram.org",
    userHandle: "handle",
    createdDate: 5,
    dcId: 2,
  });
}

function wipe(): void {
  db.exec(
    "DELETE FROM ai_models; DELETE FROM ai_suppliers; DELETE FROM jobs; DELETE FROM job_templates; DELETE FROM tg_accounts;",
  );
}

beforeAll(async () => {
  const database = await import("../db/database");
  db = database.db as any;
  ({ savePasskeySecret } = await import("../tg/passkeyStore"));
  const { default: dataRouter } = await import("../routes/data");
  const { default: accountsRouter } = await import("../routes/accounts");
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use("/data", dataRouter);
  app.use("/accounts", accountsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server!.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  wipe();
  seed();
});

async function exportAll() {
  const { decryptPayload } = await import("../db/exportCrypto");
  const { body } = await postJson("/data/export", { secret: SECRET });
  return JSON.parse(decryptPayload(body, SECRET));
}

async function exportAccounts() {
  const { decryptPayload } = await import("../db/exportCrypto");
  const { body } = await postJson("/accounts/export", { secret: SECRET });
  return JSON.parse(decryptPayload(body, SECRET));
}

describe("full backup covers every column", () => {
  it("exports every account column that belongs in a backup", async () => {
    const payload = await exportAll();
    expectCoversEveryColumn("tg_accounts", payload.accounts[0]);
  });

  it("exports every job column that belongs in a backup", async () => {
    const payload = await exportAll();
    expectCoversEveryColumn("jobs", payload.jobs[0]);
    // The remapped references travel as array indices
    expect(payload.jobs[0]).toMatchObject({ accountIndex: 0, templateIndex: 0 });
  });

  it("exports every template column that belongs in a backup", async () => {
    const payload = await exportAll();
    expectCoversEveryColumn("job_templates", payload.templates[0]);
  });
});

describe("account-only backup covers every column", () => {
  it("exports every account column that belongs in a backup", async () => {
    const payload = await exportAccounts();
    expectCoversEveryColumn("tg_accounts", payload.accounts[0], {
      additional_attributes: "additionalAttributes",
    });
  });
});

describe("full backup round-trip", () => {
  it("restores accounts, jobs and templates field for field", async () => {
    const payload = await exportAll();
    wipe();

    const imported = await postJson("/data/import", {
      data: payload,
      mode: "merge",
      secret: undefined,
      forceReauth: false,
    });
    expect(imported.status).toBe(200);

    const account = db.prepare("SELECT * FROM tg_accounts").get() as any;
    expect(account).toMatchObject({
      name: "A_1",
      phone_number: "+61400000001",
      auth_status: "authenticated",
      proxy_id: "p1",
      app_client_id: "client-1",
      disabled: 1,
      sort_order: 7,
      tg_display_name: "Jane Doe",
      tg_username: "jane",
      notes: "bought 2026-01-02",
    });
    expect(JSON.parse(account.additional_attributes)).toMatchObject({
      hasEmail: true,
      restriction: "limited",
    });
    expect(JSON.parse(account.passkey)).toMatchObject({
      telegramPasskeyId: "pk1",
      privateKeyPem: "pem",
      dcId: 2,
    });

    const job = db.prepare("SELECT * FROM jobs").get() as any;
    expect(job).toMatchObject({
      name: "J_1",
      job_type: "checkin",
      bot_username: "@bot",
      schedule_window_start: 900,
      schedule_window_end: 1000,
      timezone: "Australia/Perth",
      reply_timeout_ms: 42000,
      retry_max: 6,
      enabled: 0,
      config: '{"b":2}',
      start_command: "/start2",
      checkin_button: "sign2",
      run_every_days: 4,
      run_every_days_max: 9,
      retired: "2026-07-01T00:00:00.000Z",
      last_success_at: "2026-07-02T00:00:00.000Z",
    });
    // The job still points at the restored account and template
    expect(job.account_id).toBe(account.id);
    expect(job.template_id).toBe((db.prepare("SELECT id FROM job_templates").get() as any).id);

    const template = db.prepare("SELECT * FROM job_templates").get() as any;
    expect(template).toMatchObject({
      name: "T_1",
      timezone: "Australia/Sydney",
      reply_timeout_ms: 41000,
      retry_max: 4,
      enabled: 0,
      config: '{"a":1}',
      start_command: "/go",
      checkin_button: "sign",
      run_every_days: 3,
      run_every_days_max: 6,
    });
  });

  it("clears a proxy reference this instance does not have, by design", async () => {
    const payload = await exportAll();
    wipe();
    db.prepare("DELETE FROM settings WHERE key = 'proxies'").run();
    // Strip it from the payload too, so the import cannot restore the list
    delete payload.settings.proxies;

    const imported = await postJson("/data/import", {
      data: payload,
      mode: "merge",
      forceReauth: false,
    });
    expect(imported.body.proxyRefsCleared).toBeGreaterThan(0);
    expect((db.prepare("SELECT proxy_id FROM tg_accounts").get() as any).proxy_id).toBeNull();
  });

  it("keeps an archived job archived rather than bringing it back live", async () => {
    const payload = await exportAll();
    wipe();
    await postJson("/data/import", { data: payload, mode: "merge", forceReauth: false });
    const job = db.prepare("SELECT retired FROM jobs").get() as any;
    expect(job.retired).toBe("2026-07-01T00:00:00.000Z");
  });

  it("still imports an older backup that lacks the newer fields", async () => {
    const payload = await exportAll();
    for (const a of payload.accounts) {
      delete a.notes;
      delete a.sortOrder;
      delete a.tgDisplayName;
      delete a.tgUsername;
      delete a.disabled;
      delete a.appClientId;
    }
    for (const j of payload.jobs) {
      delete j.runEveryDays;
      delete j.runEveryDaysMax;
      delete j.retired;
      delete j.lastSuccessAt;
    }
    for (const t of payload.templates) {
      delete t.enabled;
      delete t.runEveryDays;
      delete t.runEveryDaysMax;
    }
    wipe();

    const imported = await postJson("/data/import", {
      data: payload,
      mode: "merge",
      forceReauth: false,
    });
    expect(imported.status).toBe(200);
    const account = db.prepare("SELECT * FROM tg_accounts").get() as any;
    expect(account).toMatchObject({ notes: null, sort_order: 0, disabled: 0 });
    const job = db.prepare("SELECT * FROM jobs").get() as any;
    expect(job).toMatchObject({ run_every_days: 1, run_every_days_max: null, retired: null });
    // A template with no exported flag stays usable
    expect((db.prepare("SELECT enabled FROM job_templates").get() as any).enabled).toBe(1);
  });
});

describe("account-only backup round-trip", () => {
  it("restores the operator's own fields and the passkey", async () => {
    const payload = await exportAccounts();
    wipe();

    const imported = await postJson("/accounts/import", {
      data: payload,
      forceReauth: false,
    });
    expect(imported.body).toMatchObject({ imported: 1, skipped: 0 });

    const account = db.prepare("SELECT * FROM tg_accounts").get() as any;
    expect(account).toMatchObject({
      name: "A_1",
      notes: "bought 2026-01-02",
      sort_order: 7,
      tg_display_name: "Jane Doe",
      tg_username: "jane",
      app_client_id: "client-1",
      disabled: 1,
      auth_status: "authenticated",
    });
    expect(JSON.parse(account.passkey)).toMatchObject({ telegramPasskeyId: "pk1" });
  });

  it("clears the session on a force-reauth import but keeps the rest", async () => {
    const payload = await exportAccounts();
    wipe();
    await postJson("/accounts/import", { data: payload, forceReauth: true });

    const account = db.prepare("SELECT * FROM tg_accounts").get() as any;
    expect(account.session_string).toBeNull();
    expect(account.auth_status).toBe("unauthenticated");
    expect(account.notes).toBe("bought 2026-01-02");
    // The passkey is what makes a re-login possible, so it must survive
    expect(JSON.parse(account.passkey)).toMatchObject({ telegramPasskeyId: "pk1" });
  });

  it("still imports an older account backup with none of the newer fields", async () => {
    const payload = await exportAccounts();
    for (const a of payload.accounts) {
      delete a.notes;
      delete a.sortOrder;
      delete a.tgDisplayName;
      delete a.tgUsername;
    }
    wipe();
    const imported = await postJson("/accounts/import", { data: payload, forceReauth: false });
    expect(imported.body).toMatchObject({ imported: 1 });
    expect(db.prepare("SELECT * FROM tg_accounts").get()).toMatchObject({
      notes: null,
      sort_order: 0,
      tg_display_name: null,
    });
  });
});
