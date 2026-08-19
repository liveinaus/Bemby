// Reading one chat's history across many accounts. What is worth pinning down here is the part
// that decides what comes out: where the date cut stops the read, what the regex takes from a
// message, and how a line is rendered -- including the store write, which is off unless the
// data store is switched on.

let dataStoreOn = true;
const writes: Array<{ folder: string; key: string; value: unknown }> = [];

vi.mock("../db/dataStore", () => ({
  isDataStoreEnabled: () => dataStoreOn,
  dataStoreOffReason: () => "the data store is switched off",
  isValidDataName: (name: string) =>
    /^[^[\]{}]{1,128}$/.test(name) && name === name.trim(),
  parseDataValue: (input: string) => input,
  writeDataValue: (folder: string, key: string, _path: string, value: unknown) => {
    writes.push({ folder, key, value });
  },
}));

let messages: any[] = [];
const resolved = { title: "Codes Group" };

vi.mock("../tg/liveClient", () => ({
  getLiveClient: async () => ({
    client: {
      // eslint-disable-next-line require-yield
      iterMessages: async function* (_entity: unknown, params: any) {
        let sent = 0;
        for (const msg of messages) {
          if (params?.search && !String(msg.message ?? "").includes(params.search)) continue;
          if (params?.limit && sent >= params.limit) return;
          sent++;
          yield msg;
        }
      },
    },
  }),
}));

vi.mock("../tg/peerTarget", async () => {
  const actual = await vi.importActual<typeof import("../tg/peerTarget")>("../tg/peerTarget");
  return { ...actual, resolvePeerTarget: async () => resolved };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  compileExtractRegex,
  extractMessagesForAccount,
  formatExtractLine,
  getExtractResults,
  invalidTargetReason,
  resetExtractResults,
  validateStoreOptions,
  type ExtractMessagesOptions,
} from "../jobs/bulkExtract";

const DAY = 86400;
const NOW = 1_770_000_000;

function msg(id: number, text: string, ageDays = 0) {
  return { id, message: text, date: NOW - ageDays * DAY, fromId: undefined };
}

function options(over: Partial<ExtractMessagesOptions> = {}): ExtractMessagesOptions {
  return {
    target: "@codes",
    afterEpoch: 0,
    maxMessages: 100,
    search: "",
    pattern: "",
    keepUnmatched: false,
    lineFormat: "{value}",
    store: null,
    ...over,
  };
}

const ctx = {
  taskId: "task-1",
  cancelled: () => false,
  sleep: async () => {},
  progress: () => {},
};

beforeEach(() => {
  resetExtractResults();
  writes.length = 0;
  dataStoreOn = true;
  messages = [];
});

async function run(over: Partial<ExtractMessagesOptions> = {}, context = ctx) {
  return extractMessagesForAccount(7, "acct-a", options(over), context);
}

describe("compileExtractRegex", () => {
  it("takes a bare pattern and the /pattern/flags form, always global", () => {
    expect(compileExtractRegex("code (\\w+)").flags).toContain("g");
    const delimited = compileExtractRegex("/code (\\w+)/i");
    expect(delimited.source).toBe("code (\\w+)");
    expect(delimited.flags).toBe("gi");
  });
});

describe("formatExtractLine", () => {
  const fields = { value: "ABC", account: "acct-a", id: "5" };

  it("fills the named fields and the capture groups", () => {
    expect(formatExtractLine("{account}: {value} (#{id})", fields, [])).toBe(
      "acct-a: ABC (#5)",
    );
    expect(formatExtractLine("{1}/{2}", fields, ["whole", "one", "two"])).toBe("one/two");
  });

  it("leaves an unknown name empty rather than printing it", () => {
    expect(formatExtractLine("[{valeu}]", fields)).toBe("[]");
  });

  it("reads \\t and \\n as the characters they name", () => {
    expect(formatExtractLine("{account}\\t{value}\\n", fields)).toBe("acct-a\tABC\n");
  });
});

describe("invalidTargetReason", () => {
  it("passes what names a chat and refuses what does not", () => {
    expect(invalidTargetReason("@somegroup")).toBeNull();
    expect(invalidTargetReason("https://t.me/+AbC123")).toBeNull();
    expect(invalidTargetReason("")).toMatch(/required/);
    expect(invalidTargetReason("9lives")).toMatch(/does not name a chat/);
  });
});

describe("validateStoreOptions", () => {
  const store = { folder: "codes", keyFormat: "{id}", valueFormat: "{value}" };

  it("refuses a write when the data store is switched off", () => {
    dataStoreOn = false;
    expect(validateStoreOptions(store)).toBe("the data store is switched off");
  });

  it("refuses a folder name the store would not take", () => {
    expect(validateStoreOptions({ ...store, folder: "co{des}" })).toMatch(/brace/);
  });

  it("accepts a usable target", () => {
    expect(validateStoreOptions(store)).toBeNull();
  });
});

describe("extractMessagesForAccount", () => {
  it("takes whole message texts when there is no pattern, oldest line first", async () => {
    messages = [msg(3, "third"), msg(2, "second"), msg(1, "first")];
    const result = await run();
    expect(result.scanned).toBe(3);
    expect(result.lines).toBe(3);
    expect(getExtractResults("task-1")!.lines.map((l) => l.line)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("stops at the date cut rather than paging on through the backlog", async () => {
    messages = [msg(3, "new"), msg(2, "old", 10), msg(1, "older", 20)];
    const result = await run({ afterEpoch: NOW - 5 * DAY });
    expect(result.scanned).toBe(1);
    expect(result.lines).toBe(1);
  });

  it("takes capture group 1 where the pattern has one, every match in a message", async () => {
    messages = [msg(1, "code: AAA and code: BBB"), msg(2, "nothing here")];
    const result = await run({ pattern: "/code: (\\w+)/i" });
    expect(result.matched).toBe(1);
    expect(getExtractResults("task-1")!.lines.map((l) => l.value)).toEqual(["AAA", "BBB"]);
  });

  it("keeps a blank line for an unmatched message only when asked to", async () => {
    messages = [msg(1, "code: AAA"), msg(2, "nothing here")];
    expect((await run({ pattern: "code: (\\w+)" })).lines).toBe(1);

    resetExtractResults();
    const kept = await run({ pattern: "code: (\\w+)", keepUnmatched: true });
    expect(kept.lines).toBe(2);
    expect(kept.matched).toBe(1);
  });

  it("narrows the read with Telegram's own search before the pattern runs", async () => {
    messages = [msg(1, "code: AAA"), msg(2, "chatter")];
    expect((await run({ search: "code" })).scanned).toBe(1);
  });

  it("never stalls on a pattern that can match nothing", async () => {
    messages = [msg(1, "abc")];
    const result = await run({ pattern: "x*" });
    expect(result.scanned).toBe(1);
  });

  it("writes each line into the data store under the formatted key", async () => {
    messages = [msg(9, "code: AAA")];
    const result = await run({
      pattern: "code: (\\w+)",
      store: { folder: "codes", keyFormat: "{account}-{id}", valueFormat: "{value}" },
    });
    expect(result.stored).toBe(1);
    expect(writes).toEqual([{ folder: "codes", key: "acct-a-9", value: "AAA" }]);
  });

  it("fails the item over a record key the store would reject, keeping what it read", async () => {
    // Newest first on the way in, so the usable key is written before the bad one is reached
    messages = [msg(2, "code: AAA"), msg(1, "code: A{B}C")];
    await expect(
      run({
        pattern: "code: (\\S+)",
        store: { folder: "codes", keyFormat: "{value}", valueFormat: "{value}" },
      }),
    ).rejects.toThrow(/data store accepts/);
    // Everything read before the failure is still collected rather than thrown away with it
    expect(getExtractResults("task-1")!.lines.map((l) => l.value)).toEqual([
      "A{B}C",
      "AAA",
    ]);
    expect(writes).toEqual([{ folder: "codes", key: "AAA", value: "AAA" }]);
  });

  it("keeps what it read but reports a terminate as a terminate", async () => {
    messages = [msg(2, "b"), msg(1, "a")];
    let calls = 0;
    const cancelling = { ...ctx, cancelled: () => ++calls > 1 };
    await expect(run({}, cancelling)).rejects.toThrow("Terminated");
    expect(getExtractResults("task-1")!.lines).toHaveLength(1);
  });
});
