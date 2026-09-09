// Flood-wait bookkeeping. The wait itself is the thing being managed here: Telegram raises it
// on the connect handshake, and reconnecting before it expires is what walks a 60-second wait
// up to several hundred, so recording it correctly is the whole fix.

import { beforeEach, describe, expect, it } from "vitest";
import {
  accountScope,
  clearFloodWait,
  exitScope,
  floodWaitMessage,
  floodWaitRemainingMs,
  noteFloodWait,
  parseFloodWaitSeconds,
} from "../tg/floodWait";
import { db } from "../db/database";

beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE key = 'tg_flood_waits'").run();
});

describe("parseFloodWaitSeconds", () => {
  it("reads the seconds off a GramJS FloodWaitError", () => {
    const err = Object.assign(
      new Error("A wait of 415 seconds is required (caused by InvokeWithLayer)"),
      { seconds: 415 },
    );
    expect(parseFloodWaitSeconds(err)).toBe(415);
  });

  // The job wrappers (CheckinError and friends) re-throw the text and drop the class, so the
  // message has to be enough on its own or the runner would retry straight into the wait.
  it("falls back to the message when the error class is gone", () => {
    const wrapped = new Error(
      "A wait of 337 seconds is required (caused by InvokeWithLayer)",
    );
    expect(parseFloodWaitSeconds(wrapped)).toBe(337);
  });

  it("is null for anything that is not a flood wait", () => {
    expect(parseFloodWaitSeconds(new Error("AUTH_KEY_UNREGISTERED"))).toBeNull();
    expect(parseFloodWaitSeconds(new Error("checkin connect timed out"))).toBeNull();
    expect(parseFloodWaitSeconds(null)).toBeNull();
    expect(parseFloodWaitSeconds(undefined)).toBeNull();
  });

  // SLOW_MODE_WAIT is worded the same way but limits posting in one chat, not connecting.
  // Treating it as a connection wait would bench the whole account over a group's slow mode.
  it("does not mistake a slow-mode wait for a connection wait", () => {
    const slow = Object.assign(
      new Error(
        "A wait of 30 seconds is required before sending another message in this chat",
      ),
      { seconds: 30 },
    );
    expect(parseFloodWaitSeconds(slow)).toBeNull();
  });
});

describe("recording a wait", () => {
  it("holds off every scope it was raised against", () => {
    const scopes = [accountScope(7), exitScope("proxy-a")];
    noteFloodWait(scopes, 120);

    expect(floodWaitRemainingMs([accountScope(7)])).toBeGreaterThan(0);
    expect(floodWaitRemainingMs([exitScope("proxy-a")])).toBeGreaterThan(0);
    // Another account behind another exit is unaffected
    expect(floodWaitRemainingMs([accountScope(8), exitScope("proxy-b")])).toBe(0);
  });

  // Accounts with no proxy all leave from the host's address, so they share one bucket:
  // a wait earned by one of them is a wait for the rest.
  it("puts every direct account behind the one exit", () => {
    noteFloodWait([exitScope(null)], 120);
    expect(floodWaitRemainingMs([exitScope(undefined)])).toBeGreaterThan(0);
  });

  it("keeps the longer of two waits", () => {
    noteFloodWait([accountScope(9)], 600);
    const long = floodWaitRemainingMs([accountScope(9)]);

    noteFloodWait([accountScope(9)], 5);

    // A short wait arriving second must not release the account early
    expect(floodWaitRemainingMs([accountScope(9)])).toBeGreaterThan(long - 5_000);
  });

  it("reports the longest wait covering the scopes asked about", () => {
    noteFloodWait([accountScope(10)], 60);
    noteFloodWait([exitScope("proxy-c")], 600);

    const remaining = floodWaitRemainingMs([
      accountScope(10),
      exitScope("proxy-c"),
    ]);
    expect(remaining).toBeGreaterThan(500_000);
  });

  it("ignores a zero or negative wait", () => {
    noteFloodWait([accountScope(11)], 0);
    expect(floodWaitRemainingMs([accountScope(11)])).toBe(0);
  });

  it("survives a restart, since a long wait outlives the process", () => {
    noteFloodWait([accountScope(12)], 300);
    const stored = db
      .prepare("SELECT value FROM settings WHERE key = 'tg_flood_waits'")
      .get() as { value: string } | undefined;

    expect(stored?.value).toBeTruthy();
    expect(JSON.parse(stored!.value)[accountScope(12)]).toBeGreaterThan(Date.now());
  });

  it("drops entries that have expired rather than growing the row forever", () => {
    // An entry already in the past, as a restart would leave behind
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('tg_flood_waits', ?)",
    ).run(JSON.stringify({ [accountScope(13)]: Date.now() - 1_000 }));

    expect(floodWaitRemainingMs([accountScope(13)])).toBe(0);

    noteFloodWait([accountScope(14)], 60);
    const stored = JSON.parse(
      (db
        .prepare("SELECT value FROM settings WHERE key = 'tg_flood_waits'")
        .get() as { value: string }).value,
    );
    expect(Object.keys(stored)).toEqual([accountScope(14)]);
  });

  it("clears a wait on request, for a deliberate run-anyway", () => {
    noteFloodWait([accountScope(15)], 300);
    clearFloodWait([accountScope(15)]);
    expect(floodWaitRemainingMs([accountScope(15)])).toBe(0);
  });

  it("is clear when nothing was ever recorded", () => {
    expect(floodWaitRemainingMs([accountScope(99)])).toBe(0);
    expect(floodWaitRemainingMs([])).toBe(0);
  });
});

describe("floodWaitMessage", () => {
  it("words a long wait in minutes and seconds", () => {
    expect(floodWaitMessage(415_000)).toContain("6m 55s");
  });

  it("words a short wait in seconds alone", () => {
    expect(floodWaitMessage(20_000)).toContain("20s");
  });
});
