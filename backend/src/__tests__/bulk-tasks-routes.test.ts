// Contract tests for /api/bulk-tasks: starting a background task, watching it
// progress, terminating it, and the guards that keep bad requests out.

import Database from "better-sqlite3";
import http from "http";
import express from "express";

// The credential/passkey/clean/login-email endpoints are gated on this flag
process.env.BULK_ACCOUNT_MANAGEMENT = "1";

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
  getDefaultTgApiCredentials: () => ({ apiId: 1, apiHash: "hash" }),
}));

const checkSpamStatus = vi.fn();
const cleanAccount = vi.fn();
/** History the fake Telegram client hands back, newest first, for the extraction tests. */
let history: Array<{ id: number; message: string; date: number }> = [];

vi.mock("../jobs/checkin", () => ({
  checkSpamStatus,
  expandCommand: (s: string) => s,
}));
vi.mock("../tg/liveClient", () => ({
  cleanAccount,
  getLiveClient: vi.fn(async () => ({
    client: {
      getEntity: async () => ({ title: "Codes Group" }),
      iterMessages: async function* () {
        for (const msg of history) yield msg;
      },
    },
  })),
  isAuthError: () => false,
  markSessionExpired: vi.fn(),
  syncDialogsInBackground: vi.fn(async () => undefined),
}));
vi.mock("../auth/tgAuth", () => ({
  checkAccountStatus: vi.fn(),
  getPasswordInfo: vi.fn(),
  getPasskeys: vi.fn(async () => []),
  registerPasskey: vi.fn(),
  deletePasskey: vi.fn(),
  getSessionDc: vi.fn(() => null),
  terminateOtherSessions: vi.fn(),
  updateTwoFa: vi.fn(),
  verifyPasskeyLogin: vi.fn(),
}));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn(), parseTgProxy: vi.fn() }));

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { resetBulkTasks } from "../jobs/bulkTasks";

let server: http.Server | undefined;
let baseUrl = "";

const SCHEMA = `
  CREATE TABLE tg_accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL DEFAULT '',
    phone_number  TEXT    NOT NULL DEFAULT '',
    api_id        INTEGER,
    api_hash      TEXT,
    session_string TEXT,
    auth_status   TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    disabled      INTEGER NOT NULL DEFAULT 0,
    proxy_id      TEXT,
    app_client_id TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    tg_display_name TEXT,
    tg_username   TEXT,
    notes         TEXT,
    passkey       TEXT,
    additional_attributes TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

async function getJson(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function postJson(path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

async function del(path: string) {
  const res = await fetch(`${baseUrl}${path}`, { method: "DELETE" });
  return { status: res.status, body: await res.json() };
}

function insertAccount(name: string, authenticated = true): number {
  const { lastInsertRowid } = testDb
    .prepare(
      `INSERT INTO tg_accounts (name, phone_number, session_string, auth_status)
       VALUES (?, '+100', ?, ?)`,
    )
    .run(name, authenticated ? "session" : null, authenticated ? "authenticated" : "unauthenticated");
  return Number(lastInsertRowid);
}

async function waitForState(id: string, state: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await getJson(`/bulk-tasks/${id}`);
    if (body.state === state) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`task never reached ${state}`);
}

async function waitForItemStatus(
  id: string,
  index: number,
  status: string,
  timeoutMs = 3000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await getJson(`/bulk-tasks/${id}`);
    if (body.items?.[index]?.status === status) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`item ${index} never reached ${status}`);
}

beforeAll(async () => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);
  const { default: router } = await import("../routes/bulk-tasks");
  const app = express();
  app.use(express.json());
  app.use("/bulk-tasks", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server!.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => server?.close());

beforeEach(() => {
  vi.clearAllMocks();
  resetBulkTasks();
  history = [];
  testDb.exec("DELETE FROM tg_accounts");
});

async function getText(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.text() };
}

describe("bulk task endpoints", () => {
  it("runs a spam check across the selection and reports each result", async () => {
    const a = insertAccount("A_1");
    const b = insertAccount("A_2");
    checkSpamStatus.mockResolvedValue({ spamStatus: "free", rawMessage: "Good news" });

    const started = await postJson("/bulk-tasks/spam-check", {
      ids: [a, b],
      gapSeconds: 0,
    });
    expect(started.status).toBe(201);
    expect(started.body.total).toBe(2);

    const finished = await waitForState(started.body.id, "completed");
    expect(finished.items.map((i: any) => i.status)).toEqual(["done", "done"]);
    expect(finished.items[0].data.spamStatus).toBe("free");
    expect(checkSpamStatus).toHaveBeenCalledTimes(2);

    const list = await getJson("/bulk-tasks");
    expect(list.body.tasks).toHaveLength(1);
  });

  it("skips accounts without a live session and refuses a selection with none", async () => {
    const live = insertAccount("A_live");
    insertAccount("A_dead", false);
    checkSpamStatus.mockResolvedValue({ spamStatus: "free", rawMessage: "" });

    const started = await postJson("/bulk-tasks/spam-check", {
      ids: [live, 999],
      gapSeconds: 0,
    });
    expect(started.body.total).toBe(1);
    await waitForState(started.body.id, "completed");

    const none = await postJson("/bulk-tasks/spam-check", { ids: [999] });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/No authenticated accounts/);
  });

  it("terminates a running task and marks the untouched items", async () => {
    const ids = [insertAccount("A_1"), insertAccount("A_2")];
    // Long enough that the cancel below lands while the first item is in flight
    cleanAccount.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ left: 0, deleted: 0, contacts: 0, folders: 0, failed: [] }), 300),
        ),
    );

    const started = await postJson("/bulk-tasks/clean", { ids, gapSeconds: 0 });
    expect(started.status).toBe(201);

    const cancelled = await postJson(`/bulk-tasks/${started.body.id}/cancel`);
    expect(cancelled.body.cancelled).toBe(true);

    const finished = await waitForState(started.body.id, "cancelled");
    expect(finished.items[1].status).toBe("cancelled");
    // Terminating a task that already stopped is a no-op, not an error
    const again = await postJson(`/bulk-tasks/${started.body.id}/cancel`);
    expect(again.body.cancelled).toBe(false);
  });

  it("changes the gap mid-run, and rejects a bad one", async () => {
    const ids = [insertAccount("A_1"), insertAccount("A_2")];
    cleanAccount.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ left: 0, deleted: 0, contacts: 0, folders: 0, failed: [] }),
            100,
          ),
        ),
    );

    const started = await postJson("/bulk-tasks/clean", { ids, gapSeconds: 30 });
    expect(started.status).toBe(201);

    // The first account is done and the queue is sitting in the 30s gap
    await waitForItemStatus(started.body.id, 1, "waiting");

    const bad = await postJson(`/bulk-tasks/${started.body.id}/gap`, {
      gapSeconds: -5,
    });
    expect(bad.status).toBe(400);

    const set = await postJson(`/bulk-tasks/${started.body.id}/gap`, {
      gapSeconds: 90,
    });
    expect(set.body).toEqual({ updated: true, gapSeconds: 90 });

    // Cutting the gap releases the wait already running, so the queue finishes now
    // rather than 90s from here
    await postJson(`/bulk-tasks/${started.body.id}/gap`, { gapSeconds: 0 });
    const finished = await waitForState(started.body.id, "completed");
    expect(finished.gapSeconds).toBe(0);
    expect(finished.items.map((i: any) => i.status)).toEqual(["done", "done"]);
  });

  it("pauses a running task between items and resumes it", async () => {
    const ids = [insertAccount("A_1"), insertAccount("A_2")];
    cleanAccount.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ left: 0, deleted: 0, contacts: 0, folders: 0, failed: [] }),
            100,
          ),
        ),
    );

    const started = await postJson("/bulk-tasks/clean", { ids, gapSeconds: 0 });
    expect(started.status).toBe(201);

    // Lands while the first account is in flight, so the hold takes effect after it
    const paused = await postJson(`/bulk-tasks/${started.body.id}/pause`);
    expect(paused.body.paused).toBe(true);

    const held = await waitForItemStatus(started.body.id, 1, "paused");
    expect(held.paused).toBe(true);
    expect(held.state).toBe("running");
    expect(held.items[0].status).toBe("done");

    const resumed = await postJson(`/bulk-tasks/${started.body.id}/resume`);
    expect(resumed.body.resumed).toBe(true);

    const finished = await waitForState(started.body.id, "completed");
    expect(finished.items.map((i: any) => i.status)).toEqual(["done", "done"]);
    expect(finished.paused).toBe(false);
    expect(cleanAccount).toHaveBeenCalledTimes(2);

    // Nothing to pause or resume once it has stopped
    expect((await postJson(`/bulk-tasks/${started.body.id}/pause`)).body.paused).toBe(
      false,
    );
    expect(
      (await postJson(`/bulk-tasks/${started.body.id}/resume`)).body.resumed,
    ).toBe(false);
  });

  it("only dismisses finished tasks", async () => {
    const ids = [insertAccount("A_1")];
    cleanAccount.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ left: 1, deleted: 2, contacts: 3, folders: 4, failed: [] }), 50),
        ),
    );
    const started = await postJson("/bulk-tasks/clean", { ids, gapSeconds: 0 });

    const early = await del(`/bulk-tasks/${started.body.id}`);
    expect(early.body.dismissed).toBe(false);

    await waitForState(started.body.id, "completed");
    const late = await del(`/bulk-tasks/${started.body.id}`);
    expect(late.body.dismissed).toBe(true);
    expect((await getJson("/bulk-tasks")).body.tasks).toHaveLength(0);
  });

  it("validates the credential and login-email payloads", async () => {
    const ids = [insertAccount("A_1")];
    expect((await postJson("/bulk-tasks/credentials", { ids })).status).toBe(400);
    expect(
      (await postJson("/bulk-tasks/login-email", { ids, gmail: "nope" })).status,
    ).toBe(400);
  });

  it("never echoes the submitted secrets back in the task", async () => {
    const ids = [insertAccount("A_1")];
    const started = await postJson("/bulk-tasks/credentials", {
      ids,
      newPassword: "s3cret-pw",
      gapSeconds: 0,
    });
    expect(started.status).toBe(201);
    await waitForState(started.body.id, "completed");
    const serialised = JSON.stringify((await getJson("/bulk-tasks")).body);
    expect(serialised).not.toContain("s3cret-pw");
  });
});

describe("message extraction endpoints", () => {
  const NOW = 1_770_000_000;

  it("collects the lines off the task and serves them as JSON and as a file", async () => {
    const a = insertAccount("A_1");
    history = [
      { id: 2, message: "code: BBB", date: NOW },
      { id: 1, message: "code: AAA", date: NOW - 60 },
    ];

    const started = await postJson("/bulk-tasks/extract-messages", {
      ids: [a],
      target: "@codes",
      pattern: "code: (\\w+)",
      lineFormat: "{account}----{value}",
      gapSeconds: 0,
    });
    expect(started.status).toBe(201);
    const finished = await waitForState(started.body.id, "completed");
    expect(finished.items[0].status).toBe("done");
    expect(finished.items[0].data).toMatchObject({
      chat: "Codes Group",
      scanned: 2,
      matched: 2,
      lines: 2,
      stored: 0,
    });
    // The lines themselves stay off the polled task, which only carries a short preview
    expect(finished.items[0].data.preview).toEqual(["A_1----AAA", "A_1----BBB"]);

    const results = await getJson(`/bulk-tasks/${started.body.id}/extract`);
    expect(results.body.total).toBe(2);
    expect(results.body.lines.map((l: any) => l.line)).toEqual([
      "A_1----AAA",
      "A_1----BBB",
    ]);

    const file = await getText(`/bulk-tasks/${started.body.id}/extract?format=text`);
    expect(file.body).toBe("A_1----AAA\nA_1----BBB\n");
  });

  it("refuses a chat reference that names nothing, and 404s results it never kept", async () => {
    const a = insertAccount("A_1");
    const bad = await postJson("/bulk-tasks/extract-messages", {
      ids: [a],
      target: "9lives",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/does not name a chat/);
    expect((await getJson("/bulk-tasks/no-such-task/extract")).status).toBe(404);
  });

  it("drops the collected lines when the task is dismissed", async () => {
    const a = insertAccount("A_1");
    history = [{ id: 1, message: "hello", date: NOW }];

    const started = await postJson("/bulk-tasks/extract-messages", {
      ids: [a],
      target: "@codes",
      gapSeconds: 0,
    });
    await waitForState(started.body.id, "completed");
    expect((await getJson(`/bulk-tasks/${started.body.id}/extract`)).body.total).toBe(1);

    expect((await del(`/bulk-tasks/${started.body.id}`)).body.dismissed).toBe(true);
    expect((await getJson(`/bulk-tasks/${started.body.id}/extract`)).status).toBe(404);
  });
});
