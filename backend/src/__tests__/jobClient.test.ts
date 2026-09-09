// How a job gets its Telegram connection. The point of the module under test is that a job
// borrows the pooled connection instead of building its own: every connect sends one
// InvokeWithLayer, and that is the request Telegram flood-limits per exit IP.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { MockTelegramClient, mockClientInstance, mockLease, mockRelease, mockIdentity } =
  vi.hoisted(() => {
    const mockClientInstance = {
      connect: vi.fn().mockResolvedValue(true),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    return {
      mockClientInstance,
      MockTelegramClient: vi.fn(() => mockClientInstance),
      mockRelease: vi.fn(),
      mockLease: vi.fn(),
      mockIdentity: vi.fn(),
    };
  });

vi.mock("telegram", () => ({
  TelegramClient: MockTelegramClient,
  Logger: vi.fn(),
}));
vi.mock("telegram/sessions", () => ({ StringSession: vi.fn() }));
vi.mock("telegram/extensions/Logger", () => ({ LogLevel: { NONE: 0 } }));
vi.mock("../tg/liveClient", () => ({
  leaseLiveClient: mockLease,
  liveClientIdentity: mockIdentity,
}));

import {
  FloodWaitPendingError,
  acquireJobClient,
  withJobClient,
} from "../tg/jobClient";
import { accountScope, exitScope, noteFloodWait } from "../tg/floodWait";
import { db } from "../db/database";

const POOLED_CLIENT = { pooled: true } as any;

const REQUEST = {
  label: "checkin",
  apiId: 12345,
  apiHash: "abc123",
  sessionString: "stored-session",
  accountId: 1,
  proxyId: "proxy-a",
};

beforeEach(() => {
  vi.clearAllMocks();
  db.prepare("DELETE FROM settings WHERE key = 'tg_flood_waits'").run();
  mockLease.mockResolvedValue({ client: POOLED_CLIENT, release: mockRelease });
  mockIdentity.mockReturnValue({
    apiId: REQUEST.apiId,
    sessionString: REQUEST.sessionString,
  });
});

describe("borrowing the pooled client", () => {
  it("hands out the pooled client when the stored credentials match", async () => {
    const handle = await acquireJobClient(REQUEST);

    expect(handle.pooled).toBe(true);
    expect(handle.client).toBe(POOLED_CLIENT);
    // No client of its own means no connect, which is the whole point
    expect(MockTelegramClient).not.toHaveBeenCalled();
  });

  it("releases the lease without disconnecting, so the next job finds it warm", async () => {
    const handle = await acquireJobClient(REQUEST);
    await handle.release();

    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockClientInstance.destroy).not.toHaveBeenCalled();
  });

  it("builds its own client when there is no account to borrow from", async () => {
    const handle = await acquireJobClient({ ...REQUEST, accountId: undefined });

    expect(handle.pooled).toBe(false);
    expect(mockLease).not.toHaveBeenCalled();
    expect(MockTelegramClient).toHaveBeenCalledTimes(1);
    expect(mockClientInstance.connect).toHaveBeenCalledTimes(1);
  });

  // A manual run can be given a session or credentials other than the stored ones. The pool
  // authenticates from the row, so it cannot stand in for that.
  it("builds its own client when the caller passed a different session", async () => {
    const handle = await acquireJobClient({
      ...REQUEST,
      sessionString: "some-other-session",
    });

    expect(handle.pooled).toBe(false);
    expect(mockLease).not.toHaveBeenCalled();
  });

  it("builds its own client when the caller passed a different api id", async () => {
    const handle = await acquireJobClient({ ...REQUEST, apiId: 99999 });

    expect(handle.pooled).toBe(false);
    expect(mockLease).not.toHaveBeenCalled();
  });

  it("builds its own client when the account has no pooled identity at all", async () => {
    mockIdentity.mockReturnValue(null);
    const handle = await acquireJobClient(REQUEST);

    expect(handle.pooled).toBe(false);
  });

  it("tears down a client of its own on release", async () => {
    const handle = await acquireJobClient({ ...REQUEST, accountId: undefined });
    await handle.release();

    expect(mockClientInstance.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("a wait already in force", () => {
  it("refuses to connect for the account it was raised against", async () => {
    noteFloodWait([accountScope(1)], 300);

    await expect(acquireJobClient(REQUEST)).rejects.toThrow(FloodWaitPendingError);
    expect(mockLease).not.toHaveBeenCalled();
    expect(MockTelegramClient).not.toHaveBeenCalled();
  });

  // Accounts sharing an exit share its wait: connecting another of them from the same IP is
  // what turned a handful of waits into every account waiting.
  it("refuses to connect through an exit that is waiting", async () => {
    noteFloodWait([exitScope("proxy-a")], 300);

    await expect(
      acquireJobClient({ ...REQUEST, accountId: 2 }),
    ).rejects.toThrow(FloodWaitPendingError);
  });

  it("says how long is left, so the log is actionable", async () => {
    noteFloodWait([accountScope(1)], 415);

    await expect(acquireJobClient(REQUEST)).rejects.toThrow(/6m 5[0-9]s/);
  });

  it("lets a different account behind a different exit through", async () => {
    noteFloodWait([accountScope(1), exitScope("proxy-a")], 300);
    mockIdentity.mockReturnValue(null);

    const handle = await acquireJobClient({
      ...REQUEST,
      accountId: 2,
      proxyId: "proxy-b",
    });
    expect(handle.pooled).toBe(false);
  });
});

describe("a wait raised by the connect itself", () => {
  it("is recorded against the account and the exit", async () => {
    mockLease.mockRejectedValue(
      Object.assign(
        new Error("A wait of 200 seconds is required (caused by InvokeWithLayer)"),
        { seconds: 200 },
      ),
    );

    await expect(acquireJobClient(REQUEST)).rejects.toThrow(/A wait of 200 seconds/);

    // The next attempt is refused outright rather than connecting again
    await expect(acquireJobClient(REQUEST)).rejects.toThrow(FloodWaitPendingError);
    await expect(
      acquireJobClient({ ...REQUEST, accountId: 2 }),
    ).rejects.toThrow(FloodWaitPendingError);
  });

  it("records one raised on a client of its own too", async () => {
    mockClientInstance.connect.mockRejectedValueOnce(
      new Error("A wait of 90 seconds is required (caused by InvokeWithLayer)"),
    );

    await expect(
      acquireJobClient({ ...REQUEST, accountId: undefined }),
    ).rejects.toThrow(/A wait of 90 seconds/);

    await expect(
      acquireJobClient({ ...REQUEST, accountId: undefined }),
    ).rejects.toThrow(FloodWaitPendingError);
  });

  it("leaves no cooldown behind for an ordinary failure", async () => {
    mockLease.mockRejectedValueOnce(new Error("AUTH_KEY_UNREGISTERED"));

    await expect(acquireJobClient(REQUEST)).rejects.toThrow("AUTH_KEY_UNREGISTERED");

    // Still connectable: a dead session is not a reason to bench the exit
    const handle = await acquireJobClient(REQUEST);
    expect(handle.pooled).toBe(true);
  });
});

describe("withJobClient", () => {
  it("releases the client when the operation throws", async () => {
    await expect(
      withJobClient(REQUEST, async () => {
        throw new Error("bot never replied");
      }),
    ).rejects.toThrow("bot never replied");

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("returns the operation's result and releases", async () => {
    const result = await withJobClient(REQUEST, async (client) => {
      expect(client).toBe(POOLED_CLIENT);
      return "done";
    });

    expect(result).toBe("done");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("bounds the operation, so a stalled RPC fails this account alone", async () => {
    await expect(
      withJobClient(REQUEST, () => new Promise(() => {}), 20),
    ).rejects.toThrow(/timed out/);

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
