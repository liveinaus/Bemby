// A login email set by hand from the account panel is the same change the automated run makes,
// so it has to leave the same record behind: without it the account still reads as having no
// email, and the address Bemby handed out is nowhere.

import Database from "better-sqlite3";
import http from "http";
import express from "express";

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
  getDefaultTgApiCredentials: () => ({ apiId: 1, apiHash: "hash" }),
}));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));

const mocks = vi.hoisted(() => ({
  sendLoginEmailCode: vi.fn(async () => ({ emailPattern: "a***@x.com", codeLength: 6 })),
  verifyLoginEmail: vi.fn(),
}));

vi.mock("../auth/tgAuth", () => ({
  requestCode: vi.fn(),
  submitCode: vi.fn(),
  submitPassword: vi.fn(),
  checkAccountStatus: vi.fn(),
  resendCodeAsSms: vi.fn(),
  updateTwoFa: vi.fn(),
  getSessions: vi.fn(),
  terminateSession: vi.fn(),
  terminateOtherSessions: vi.fn(),
  getPasswordInfo: vi.fn(),
  getPasskeys: vi.fn(),
  registerPasskey: vi.fn(),
  deletePasskey: vi.fn(),
  getSessionDc: vi.fn(),
  verifyPasskeyLogin: vi.fn(),
  sendLoginEmailCode: mocks.sendLoginEmailCode,
  verifyLoginEmail: mocks.verifyLoginEmail,
}));
vi.mock("../jobs/checkin", () => ({ checkSpamStatus: vi.fn() }));
vi.mock("../jobs/runner", () => ({
  parseTgProxy: vi.fn(() => undefined),
  runJob: vi.fn(),
}));
vi.mock("../tg/liveClient", () => ({
  cleanAccount: vi.fn(),
  getLiveClient: vi.fn(),
  isAuthError: () => false,
  markSessionExpired: vi.fn(),
  syncDialogsInBackground: vi.fn(),
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const SCHEMA = `
  CREATE TABLE tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    phone_number   TEXT    NOT NULL DEFAULT '',
    api_id         INTEGER,
    api_hash       TEXT,
    session_string TEXT,
    auth_status    TEXT    NOT NULL DEFAULT 'unauthenticated',
    proxy_id       TEXT,
    disabled       INTEGER NOT NULL DEFAULT 0,
    app_client_id  TEXT,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    tg_display_name TEXT,
    tg_username    TEXT,
    notes          TEXT,
    passkey        TEXT,
    additional_attributes TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
`;

let server: http.Server;
let baseUrl: string;
let accountId = 0;

const verify = (body: unknown) =>
  fetch(`${baseUrl}/accounts/${accountId}/login-email/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const attributes = (): Record<string, unknown> => {
  const row = testDb
    .prepare("SELECT additional_attributes FROM tg_accounts WHERE id = ?")
    .get(accountId) as { additional_attributes: string | null };
  return row.additional_attributes ? JSON.parse(row.additional_attributes) : {};
};

beforeAll(async () => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);

  const { default: accountsRouter } = await import("../routes/accounts");
  const app = express();
  app.use(express.json());
  app.use("/accounts", accountsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  testDb.exec("DELETE FROM tg_accounts; DELETE FROM settings;");
  const { lastInsertRowid } = testDb
    .prepare(
      `INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status)
       VALUES ('A_1', '+61400000000', 111, 'own-hash', 'session', 'authenticated')`,
    )
    .run();
  accountId = Number(lastInsertRowid);
});

describe("manual login email change", () => {
  it("records the address Telegram confirmed", async () => {
    mocks.verifyLoginEmail.mockResolvedValue({ email: "pool-42@outlook.com" });
    const res = await verify({ code: "123456", email: "typed@outlook.com" });
    expect(res.status).toBe(200);
    expect(attributes()).toEqual({
      hasEmail: true,
      loginEmail: "pool-42@outlook.com",
    });
  });

  it("falls back to the address the code was sent to", async () => {
    mocks.verifyLoginEmail.mockResolvedValue({ email: null });
    await verify({ code: "123456", email: " typed@outlook.com " });
    expect(attributes()).toEqual({
      hasEmail: true,
      loginEmail: "typed@outlook.com",
    });
  });

  it("still marks the account when neither side names an address", async () => {
    mocks.verifyLoginEmail.mockResolvedValue({ email: null });
    await verify({ code: "123456" });
    expect(attributes()).toEqual({ hasEmail: true });
  });

  it("records nothing when the code is refused", async () => {
    mocks.verifyLoginEmail.mockRejectedValue(new Error("CODE_INVALID"));
    const res = await verify({ code: "000000", email: "typed@outlook.com" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(attributes()).toEqual({});
  });
});
