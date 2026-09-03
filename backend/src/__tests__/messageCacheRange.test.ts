// What the message cache is allowed to claim it holds.
//
// Runs against a real in-memory SQLite rather than a mocked `db`: the whole point of the
// range table is the SQL that decides whether a cached page is complete, and a mock would
// only assert that the queries were called.

import Database from "better-sqlite3";

const memDb = vi.hoisted(() => {
  const Db = require("better-sqlite3");
  const database = new Db(":memory:");
  database.exec(`
    CREATE TABLE tg_message_cache (
      account_id INTEGER NOT NULL,
      chat_id    TEXT    NOT NULL,
      msg_id     INTEGER NOT NULL,
      msg_date   INTEGER NOT NULL,
      payload    TEXT    NOT NULL,
      PRIMARY KEY (account_id, chat_id, msg_id)
    );
    CREATE TABLE tg_chat_sync (
      account_id    INTEGER NOT NULL,
      chat_id       TEXT    NOT NULL,
      min_id        INTEGER NOT NULL,
      max_id        INTEGER NOT NULL,
      has_start     INTEGER NOT NULL DEFAULT 0,
      reconciled_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, chat_id)
    );
  `);
  return database as InstanceType<typeof Database>;
});

vi.mock("../db/database", () => ({
  db: memDb,
  getDefaultTgApiCredentials: () => null,
}));

vi.mock("../jobs/runner", () => ({
  parseTgProxy: vi.fn().mockReturnValue(undefined),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cacheMessages,
  getCachedMessages,
  getCachedMessage,
  patchCachedMessage,
  cachedChatsForMessages,
  removeCachedMessages,
  clearCachedMessages,
  recordChatRange,
  getChatRange,
  cacheCoversRequest,
  type TgMsgPayload,
} from "../tg/liveClient";

const ACC = 1;
const CHAT = "u100";

function msg(id: number, text = `m${id}`): TgMsgPayload {
  return {
    id,
    text,
    html: null,
    date: 1_700_000_000 + id,
    fromMe: false,
    isRead: false,
    fromId: "u200",
    fromName: "Sender",
    hasPhoto: false,
    hasDocument: false,
    hasSticker: false,
    fileName: null,
    buttons: null,
    reactions: null,
    replyToId: null,
    replyToText: null,
    replyToName: null,
    replyCount: null,
  };
}

/** A page of ids, newest first, as getMessages returns them. */
function page(from: number, to: number): TgMsgPayload[] {
  const out: TgMsgPayload[] = [];
  for (let id = from; id >= to; id--) out.push(msg(id));
  return out;
}

beforeEach(() => {
  memDb.exec("DELETE FROM tg_message_cache; DELETE FROM tg_chat_sync;");
});

describe("cacheCoversRequest", () => {
  it("refuses a cache with no recorded range, however many rows it holds", () => {
    // This is the state every chat is in immediately after upgrading: rows, no range
    cacheMessages(ACC, CHAT, page(100, 51));

    expect(getChatRange(ACC, CHAT)).toBeNull();
    expect(cacheCoversRequest(ACC, CHAT, 50)).toBe(false);
  });

  it("refuses a short run, which is the bug that made three rows answer a fifty-row request", () => {
    cacheMessages(ACC, CHAT, page(100, 98));
    recordChatRange(ACC, CHAT, { minId: 98, maxId: 100, hasStart: false });

    expect(cacheCoversRequest(ACC, CHAT, 50)).toBe(false);
    expect(cacheCoversRequest(ACC, CHAT, 3)).toBe(true);
  });

  it("accepts a short run when the cache reaches the start of the chat", () => {
    cacheMessages(ACC, CHAT, page(3, 1));
    recordChatRange(ACC, CHAT, { minId: 1, maxId: 3, hasStart: true });

    expect(cacheCoversRequest(ACC, CHAT, 50)).toBe(true);
  });

  it("refuses a page older than anything the range covers", () => {
    cacheMessages(ACC, CHAT, page(100, 51));
    recordChatRange(ACC, CHAT, { minId: 51, maxId: 100, hasStart: false });

    expect(cacheCoversRequest(ACC, CHAT, 20, 80)).toBe(true);
    // Paginating past the bottom of the range has to go back to Telegram
    expect(cacheCoversRequest(ACC, CHAT, 20, 51)).toBe(false);
    expect(cacheCoversRequest(ACC, CHAT, 20, 40)).toBe(false);
  });
});

describe("recordChatRange", () => {
  it("merges a page that overlaps the known range", () => {
    recordChatRange(ACC, CHAT, { minId: 51, maxId: 100, hasStart: false });
    recordChatRange(ACC, CHAT, { minId: 20, maxId: 60, hasStart: false });

    expect(getChatRange(ACC, CHAT)).toEqual({
      minId: 20,
      maxId: 100,
      hasStart: false,
    });
  });

  it("merges a page that abuts the range with no overlap", () => {
    recordChatRange(ACC, CHAT, { minId: 51, maxId: 100, hasStart: false });
    recordChatRange(ACC, CHAT, { minId: 20, maxId: 50, hasStart: false });

    expect(getChatRange(ACC, CHAT)?.minId).toBe(20);
  });

  it("replaces rather than spans a gap, so completeness is never claimed across one", () => {
    recordChatRange(ACC, CHAT, { minId: 51, maxId: 100, hasStart: false });
    recordChatRange(ACC, CHAT, { minId: 10, maxId: 20, hasStart: true });

    expect(getChatRange(ACC, CHAT)).toEqual({
      minId: 10,
      maxId: 20,
      hasStart: true,
    });
  });

  it("keeps hasStart once either side has reached the beginning", () => {
    recordChatRange(ACC, CHAT, { minId: 1, maxId: 30, hasStart: true });
    recordChatRange(ACC, CHAT, { minId: 25, maxId: 60, hasStart: false });

    expect(getChatRange(ACC, CHAT)?.hasStart).toBe(true);
  });
});

describe("getCachedMessages", () => {
  it("never reaches below the floor it is given", () => {
    // Rows left below a gap by an older build, plus a complete run above it
    cacheMessages(ACC, CHAT, page(20, 11));
    cacheMessages(ACC, CHAT, page(100, 91));
    recordChatRange(ACC, CHAT, { minId: 91, maxId: 100, hasStart: false });

    const served = getCachedMessages(ACC, CHAT, 50, undefined, 91);
    expect(served).toHaveLength(10);
    expect(served.at(-1)?.id).toBe(91);

    // Without the floor the stale rows are mixed in as if contiguous
    expect(getCachedMessages(ACC, CHAT, 50)).toHaveLength(20);
  });
});

describe("cache trimming", () => {
  it("pulls the range up and drops hasStart when the oldest rows are trimmed away", () => {
    // MSG_CACHE_MAX is 500, so this trims to ids 21..520
    cacheMessages(ACC, CHAT, page(520, 1));
    recordChatRange(ACC, CHAT, { minId: 1, maxId: 520, hasStart: true });
    // One more message trims the oldest again, leaving 22..521
    cacheMessages(ACC, CHAT, [msg(521)]);

    const range = getChatRange(ACC, CHAT);
    expect(range?.minId).toBe(22);
    expect(range?.hasStart).toBe(false);
  });
});

describe("cache mutation helpers", () => {
  it("finds which chats a set of message ids was cached in", () => {
    cacheMessages(ACC, "u100", [msg(5), msg(6)]);
    cacheMessages(ACC, "u200", [msg(7)]);

    const found = cachedChatsForMessages(ACC, [5, 7, 999]);
    expect(found.get("u100")).toEqual([5]);
    expect(found.get("u200")).toEqual([7]);
    expect(found.has("u999")).toBe(false);
  });

  it("rewrites one payload in place and leaves the rest alone", () => {
    cacheMessages(ACC, CHAT, [msg(1), msg(2)]);

    patchCachedMessage(ACC, CHAT, 2, (p) => {
      p.reactions = [{ emoji: "👍", count: 1, mine: true }];
    });

    expect(getCachedMessage(ACC, CHAT, 2)?.reactions).toEqual([
      { emoji: "👍", count: 1, mine: true },
    ]);
    expect(getCachedMessage(ACC, CHAT, 1)?.reactions).toBeNull();
  });

  it("ignores a patch for a message that was never cached", () => {
    expect(() =>
      patchCachedMessage(ACC, CHAT, 42, (p) => {
        p.pinned = true;
      }),
    ).not.toThrow();
  });

  it("forgets the range when the chat's cache is cleared", () => {
    cacheMessages(ACC, CHAT, page(10, 1));
    recordChatRange(ACC, CHAT, { minId: 1, maxId: 10, hasStart: true });

    clearCachedMessages(ACC, CHAT);

    expect(getChatRange(ACC, CHAT)).toBeNull();
    expect(cacheCoversRequest(ACC, CHAT, 5)).toBe(false);
  });

  it("keeps the range intact when messages inside it are deleted", () => {
    cacheMessages(ACC, CHAT, page(10, 1));
    recordChatRange(ACC, CHAT, { minId: 1, maxId: 10, hasStart: true });

    removeCachedMessages(ACC, CHAT, [5]);

    // A deleted message does not put a hole in the range: the range means
    // "everything that still exists between these ids is here"
    expect(getChatRange(ACC, CHAT)).toEqual({
      minId: 1,
      maxId: 10,
      hasStart: true,
    });
  });
});
