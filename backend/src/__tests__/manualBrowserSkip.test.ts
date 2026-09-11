// A browser someone is signed into by hand holds that job's profile. Chromium allows one
// process per profile directory, so a scheduled run starting underneath would be handed a
// throwaway profile and act as a logged-out visitor -- quietly undoing the very thing the
// session was opened to do, and reporting whatever the logged-out page happens to say.
const { mockInsertRun, mockUpdateRun, mockPrepare, manualJobId } = vi.hoisted(() => {
  const mockInsertRun = vi.fn().mockReturnValue({ lastInsertRowid: 99 });
  const mockUpdateRun = vi.fn();
  const manualJobId = vi.fn<() => number | undefined>().mockReturnValue(undefined);
  const mockPrepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.startsWith("INSERT")) return { run: mockInsertRun };
    if (sql.startsWith("UPDATE")) return { run: mockUpdateRun };
    if (sql.includes("FROM jobs WHERE")) return { get: vi.fn().mockReturnValue(null) };
    return { get: vi.fn().mockReturnValue(null), all: vi.fn().mockReturnValue([]) };
  });
  return { mockInsertRun, mockUpdateRun, mockPrepare, manualJobId };
});

vi.mock("../db/database", () => ({ db: { prepare: mockPrepare } }));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/manualBrowser", () => ({ manualSessionJobId: manualJobId }));
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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeJob } from "../scheduler";
import { runJob } from "../jobs/runner";
import type { Job } from "../types";

const job = {
  id: 7,
  name: "Web job",
  accountId: 1,
  jobType: "custom",
  botUsername: "",
  scheduleWindowStart: 600,
  scheduleWindowEnd: 720,
  timezone: "UTC",
  replyTimeoutMs: 40_000,
  retryMax: 1,
  enabled: true,
  createdAt: "2024-01-01",
  config: null,
  startCommand: "/start",
  checkinButton: "签到",
  runEveryDays: 1,
} as Job;

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertRun.mockReturnValue({ lastInsertRowid: 99 });
  manualJobId.mockReturnValue(undefined);
});

describe("a job whose browser is open by hand", () => {
  it("does not run, and says why in the log rather than failing silently", async () => {
    manualJobId.mockReturnValue(7);

    await executeJob(job, null);

    expect(vi.mocked(runJob)).not.toHaveBeenCalled();
    const [, , message] = mockInsertRun.mock.calls[0];
    expect(message).toMatch(/browser is open for this job/i);
    // Recorded as one finished row, not a "running" one left behind for the reconciler
    expect(mockUpdateRun).not.toHaveBeenCalled();
  });

  it("runs normally once the session is closed", async () => {
    manualJobId.mockReturnValue(undefined);

    await executeJob(job, null);

    expect(vi.mocked(runJob)).toHaveBeenCalledOnce();
  });

  it("leaves every other job alone while one is being driven", async () => {
    // The hold is on the profile of the job being driven, not on the scheduler
    manualJobId.mockReturnValue(8);

    await executeJob(job, null);

    expect(vi.mocked(runJob)).toHaveBeenCalledOnce();
  });
});
