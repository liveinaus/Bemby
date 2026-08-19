import { describe, it, expect, vi } from "vitest";
import {
  connectWithTimeout,
  destroyQuietly,
  withTgClient,
  withTimeout,
} from "../tg/clientTimeout";

/** A client whose connect/destroy behave however a case needs them to. */
function fakeClient(opts: {
  connect?: () => Promise<unknown>;
  destroy?: () => Promise<unknown>;
}) {
  const calls = { connect: 0, destroy: 0 };
  return {
    calls,
    client: {
      connect: () => {
        calls.connect++;
        return opts.connect?.() ?? Promise.resolve();
      },
      destroy: () => {
        calls.destroy++;
        return opts.destroy?.() ?? Promise.resolve();
      },
    },
  };
}

const never = () => new Promise<never>(() => {});

describe("withTimeout", () => {
  it("passes a value straight through", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
  });

  it("rejects with the label once the bound passes", async () => {
    await expect(withTimeout(never(), 20, "connect")).rejects.toThrow(
      /connect timed out after 20ms/,
    );
  });
});

describe("connectWithTimeout", () => {
  it("returns once the connection is up", async () => {
    const { client, calls } = fakeClient({});
    await connectWithTimeout(client, "checkin", 1000);
    expect(calls.connect).toBe(1);
    // The caller goes on using this one, so it must not have been torn down
    expect(calls.destroy).toBe(0);
  });

  // The dead-proxy case: GramJS keeps redialling with no wall-clock limit, so without this
  // the await never settles and the whole sequential queue stops on that account.
  it("gives up on a connect that never settles", async () => {
    const { client } = fakeClient({ connect: never });
    await expect(connectWithTimeout(client, "checkin", 20)).rejects.toThrow(
      /checkin connect timed out/,
    );
  });

  it("drops the client it gave up on rather than leaking it", async () => {
    const { client, calls } = fakeClient({ connect: never });
    await connectWithTimeout(client, "checkin", 20).catch(() => undefined);
    expect(calls.destroy).toBe(1);
  });

  it("survives a teardown that fails on the way out", async () => {
    const { client } = fakeClient({
      connect: never,
      destroy: () => Promise.reject(new Error("socket already gone")),
    });
    // The connect failure is what the caller should see, not the teardown's
    await expect(connectWithTimeout(client, "checkin", 20)).rejects.toThrow(
      /checkin connect timed out/,
    );
  });
});

describe("withTgClient", () => {
  it("connects, runs the operation and tears down", async () => {
    const { client, calls } = fakeClient({});
    const out = await withTgClient(client, "spam check", async () => "free", 1000);
    expect(out).toBe("free");
    expect(calls).toEqual({ connect: 1, destroy: 1 });
  });

  it("tears down even when the operation throws", async () => {
    const { client, calls } = fakeClient({});
    await expect(
      withTgClient(
        client,
        "spam check",
        async () => {
          throw new Error("SpamBot did not reply in time");
        },
        1000,
      ),
    ).rejects.toThrow(/did not reply/);
    expect(calls.destroy).toBe(1);
  });

  it("bounds an operation that hangs after connecting", async () => {
    const { client, calls } = fakeClient({});
    await expect(
      withTgClient(client, "spam check", never, 20),
    ).rejects.toThrow(/spam check timed out/);
    expect(calls.destroy).toBe(1);
  });
});

describe("destroyQuietly", () => {
  it("swallows a teardown that throws", async () => {
    const { client } = fakeClient({
      destroy: () => Promise.reject(new Error("nope")),
    });
    await expect(destroyQuietly(client, "checkin")).resolves.toBeUndefined();
  });

  // Teardown speaks over the same connection, so the proxy that hung the connect hangs this
  it("returns rather than waiting on a teardown that never settles", async () => {
    vi.useFakeTimers();
    try {
      const { client } = fakeClient({ destroy: never });
      const done = destroyQuietly(client, "checkin");
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(done).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
