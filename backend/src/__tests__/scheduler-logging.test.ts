const { mockInsertRun, mockUpdateRun, mockJobGet, mockPrepare } = vi.hoisted(() => {
  const mockInsertRun = vi.fn().mockReturnValue({ lastInsertRowid: 99 });
  const mockUpdateRun = vi.fn();
  const mockJobGet = vi.fn().mockReturnValue(null); // null → skip job re-fetch
  const mockPrepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.startsWith("INSERT")) return { run: mockInsertRun };
    if (sql.startsWith("UPDATE")) return { run: mockUpdateRun };
    if (sql.includes("FROM jobs WHERE")) return { get: mockJobGet };
    return { get: vi.fn().mockReturnValue(null), all: vi.fn().mockReturnValue([]) };
  });
  return { mockInsertRun, mockUpdateRun, mockJobGet, mockPrepare };
});

vi.mock("../db/database", () => ({
  db: { prepare: mockPrepare },
}));

vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/cancellation", () => ({
  registerJob: vi.fn(() => new AbortController().signal),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock("../jobs/notify", () => ({
  getNotifyConfig: vi.fn().mockReturnValue({ events: [], username: null }),
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildSuccessMessage: vi.fn().mockReturnValue("ok"),
  buildFailureMessage: vi.fn().mockReturnValue("fail"),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeJob } from "../scheduler";
import { runJob } from "../jobs/runner";
import type { Job, TgAccount } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const job: Job = {
  id: 7,
  name: "Logging Test Job",
  accountId: 1,
  jobType: "checkin",
  botUsername: "@bot",
  scheduleWindowStart: 1000,
  scheduleWindowEnd: 1200,
  timezone: "UTC",
  replyTimeoutMs: 5000,
  retryMax: 1,
  enabled: true,
  createdAt: "2024-01-01T00:00:00Z",
  config: null,
  startCommand: "/start",
  checkinButton: "签到",
  runEveryDays: 1,
};

const account: TgAccount = {
  id: 1,
  name: "Acct",
  phoneNumber: "+1",
  apiId: 1,
  apiHash: "hash",
  sessionString: "session",
  authStatus: "authenticated",
  proxyId: null,
  disabled: false,
  appClientId: null,
  createdAt: "2024-01-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeJob — DB status logging", () => {
  // runJob is mocked to resolve immediately, so executeJob completes without
  // needing any timer advancement. scheduleOne creates a far-future timer
  // that never fires during the test.
  // Helper: find a SQL string that was passed to prepare()
  function preparedSqls() {
    return mockPrepare.mock.calls.map(([sql]: any[]) => sql);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertRun.mockReturnValue({ lastInsertRowid: 99 });
    vi.mocked(runJob).mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clear any lingering timers from scheduleOne's finally block
    vi.clearAllTimers();
  });

  it("inserts a job_log row with the job id before executing", async () => {
    await executeJob(job, null);
    expect(mockInsertRun).toHaveBeenCalledWith(job.id, expect.any(String));
  });

  it("updates status to 'success' after runJob resolves", async () => {
    await executeJob(job, null);
    expect(preparedSqls().some((sql) => sql.includes("'success'"))).toBe(true);
  });

  it("stores serialised detail logs in the success update", async () => {
    vi.mocked(runJob).mockImplementation(async (_job, _account, detailLogs) => {
      detailLogs?.push({ attempt: 1, commandSent: "/start" } as any);
    });

    await executeJob(job, null);

    // Find the UPDATE call that contains JSON detail data
    const detailArg = mockUpdateRun.mock.calls
      .flatMap((args) => args)
      .find((arg) => typeof arg === "string" && arg.startsWith("["));

    expect(detailArg).toBeDefined();
    const parsed = JSON.parse(detailArg as string);
    expect(parsed[0]).toMatchObject({ attempt: 1, commandSent: "/start" });
  });

  it("updates status to 'failed' when runJob throws", async () => {
    vi.mocked(runJob).mockRejectedValue(new Error("bot is down"));
    await executeJob(job, null).catch(() => {});
    expect(preparedSqls().some((sql) => sql.includes("'failed'"))).toBe(true);
  });

  it("stores the error message in the failed update", async () => {
    vi.mocked(runJob).mockRejectedValue(new Error("connection refused"));
    await executeJob(job, null).catch(() => {});
    // message, detail, the size the row records, and the row
    expect(mockUpdateRun).toHaveBeenCalledWith("connection refused", null, 0, 99);
  });

  it("marks the run as 'Cancelled' when the job is cancelled", async () => {
    vi.mocked(runJob).mockRejectedValue(new Error("Job cancelled"));
    await executeJob(job, account).catch(() => {});
    expect(mockUpdateRun).toHaveBeenCalledWith("Cancelled", null, 0, 99);
  });
});
