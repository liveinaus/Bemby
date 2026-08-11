// The three data steps inside a run: reading a record into a name the steps after it can use,
// saving what the round gathered, and removing what is no longer wanted. Driven against a
// stand-in page and the real store, so the interesting part is covered -- that a value written
// by one step is there for the next run to read, which is the point of the store.
//
// The database is a throwaway one: under vitest db/database.ts refuses the working
// directory's own file and makes a temp one, so the fixtures below clear tables that
// belong to this run alone.

import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { db } from "../db/database";
import { CF_TUNING_KEY } from "../jobs/cfTuning";
import { createFolder, createRecord, readDataRef, readDataValue } from "../db/dataStore";
import { runWebSteps } from "../jobs/cloudflare";
import type { WebStep } from "../types";

/** Enough of a page for steps that never touch one; typing is recorded so a value can be seen. */
function fakePage() {
  const typed: Array<{ selector: string; text: string }> = [];
  const page = {
    title: async () => "",
    url: () => "https://signup.example/",
    screenshot: async () => Buffer.from("a jpeg, near enough"),
    keyboard: {
      press: async () => {},
      type: async (text: string) => typed.push({ selector: "", text }),
    },
    mouse: { move: async () => {}, click: async () => {}, down: async () => {}, up: async () => {} },
    evaluate: async (fn: unknown, arg?: unknown) => {
      const body = String(fn);
      if (typeof arg === "string") {
        if (body.includes("getBoundingClientRect")) return true;
        return "";
      }
      if (body.includes("challenge-")) return false;
      return "a page with plenty of readable text on it";
    },
    fill: async (selector: string, text: string) => typed.push({ selector, text }),
    type: async (selector: string, text: string) => typed.push({ selector, text }),
  };
  return { page: page as unknown as Page, typed };
}

const run = (page: Page, steps: WebStep[]) => runWebSteps(page, steps, Date.now() + 30_000, {});

// The deployment-level gate. Unlike DB_PATH this is read when the check runs, not when the
// module is imported, so setting it here is early enough.
process.env.DATA_MANAGEMENT = "1";

beforeEach(() => {
  db.prepare("DELETE FROM data_records").run();
  db.prepare("DELETE FROM data_folders").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('data_store_enabled','true')").run();
  // Keep the between-step pauses out of the run, as the other step tests do
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    CF_TUNING_KEY,
    JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0, readyPollMs: 100 }),
  );
});

function seedExample(): void {
  const folderId = createFolder("example");
  createRecord(folderId, "email", { password: "xxxx", other: "othervalue" });
}

describe("web_data_read", () => {
  it("holds a field under the name, for a later step to type", async () => {
    seedExample();
    const { page, typed } = fakePage();
    const result = await run(page, [
      {
        type: "web_data_read",
        folder: "example",
        key: "email",
        path: "password",
        varName: "pw",
      },
      { type: "web_input", selector: "#pw", text: "{pw}" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.logs[0].outcome).toContain("{pw} = xxxx");
    expect(typed.map((entry) => entry.text)).toEqual(["xxxx"]);
  });

  it("fails the step when nothing is stored there", async () => {
    const { page } = fakePage();
    const result = await run(page, [
      { type: "web_data_read", folder: "example", key: "email", varName: "pw" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.logs[0].error).toContain("nothing is stored at data.example.email");
  });

  it("carries on without it when it is marked optional", async () => {
    const { page } = fakePage();
    const result = await run(page, [
      { type: "web_data_read", folder: "example", key: "email", varName: "pw", optional: true },
      { type: "web_delay", waitMs: 0 },
    ]);

    expect(result.ok).toBe(true);
    expect(result.logs[0].outcome).toContain("carried on");
  });

  it("refuses to reach the store while it is switched off", async () => {
    seedExample();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('data_store_enabled','false')",
    ).run();
    const { page } = fakePage();
    const result = await run(page, [
      { type: "web_data_read", folder: "example", key: "email", varName: "pw" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.logs[0].error).toContain("turned off in Settings");
  });
});

describe("web_data_save", () => {
  it("stores what the round gathered, folder and record made as needed", async () => {
    const { page } = fakePage();
    const result = await run(page, [
      { type: "web_set", varName: "username", value: "bemby_test" },
      {
        type: "web_data_save",
        folder: "sites",
        key: "example",
        value: '{"username":"{username}","password":"pw"}',
      },
    ]);

    expect(result.ok).toBe(true);
    expect(readDataRef("sites.example.username")).toBe("bemby_test");
    expect(readDataRef("sites.example.password")).toBe("pw");
  });

  // The case this was reported on: the record is keyed by the address the signup made, so the
  // key holds a dot and an @, and is built out of a name the round set
  it("keys a record by an email address built from the round's name", async () => {
    const { page, typed } = fakePage();
    const result = await run(page, [
      { type: "web_set", varName: "username", value: "Ava_Hall_7592" },
      {
        type: "web_data_save",
        folder: "example",
        key: "{username}@example.com",
        path: "password",
        value: "xxxx",
      },
      {
        type: "web_input",
        selector: "#pw",
        text: "{data.example[{username}@example.com].password}",
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.logs[1].outcome).toContain("data.example[Ava_Hall_7592@example.com].password");
    expect(readDataValue("example", "Ava_Hall_7592@example.com", "password")).toBe("xxxx");
    // And the same record read back inline, the reference built out of the name too
    expect(typed.map((entry) => entry.text)).toEqual(["xxxx"]);
  });

  it("writes one field and leaves the others where they were", async () => {
    seedExample();
    const { page } = fakePage();
    const result = await run(page, [
      {
        type: "web_data_save",
        folder: "example",
        key: "email",
        path: "password",
        value: "rotated",
      },
    ]);

    expect(result.ok).toBe(true);
    expect(readDataRef("example.email.password")).toBe("rotated");
    expect(readDataRef("example.email.other")).toBe("othervalue");
  });

  it("takes a reference to another record as its value", async () => {
    seedExample();
    const { page } = fakePage();
    const result = await run(page, [
      {
        type: "web_data_save",
        folder: "backup",
        key: "examplePassword",
        value: "{data.example.email.password}",
      },
    ]);

    expect(result.ok).toBe(true);
    expect(readDataRef("backup.examplePassword")).toBe("xxxx");
  });
});

// A folder kept as a queue: take number 0, use it, delete it, and the next run finds what had
// been number 1 in its place. The key is the part that matters here -- an account name is the
// record's key, which no `{data.folder.key}` reference can reach.
describe("web_data_pick", () => {
  /** Two accounts, added in this order, keyed the other way round on purpose. */
  function seedQueue(): void {
    const folderId = createFolder("outlook");
    createRecord(folderId, "luckycee23", { password: "p2" });
    createRecord(folderId, "jaclee324", { password: "p1" });
  }

  it("holds the key of the record at that position, oldest first", async () => {
    seedQueue();
    const { page, typed } = fakePage();
    const result = await run(page, [
      { type: "web_data_pick", folder: "outlook", varName: "un" },
      { type: "web_input", selector: "#user", text: "{un}" },
    ]);

    expect(result.ok).toBe(true);
    // Added first, though `luckycee23` is second by key: the panel's order is not this one
    expect(typed.map((entry) => entry.text)).toEqual(["luckycee23"]);
    expect(result.logs[0].outcome).toContain("{un} = luckycee23 (position 0 of outlook)");
  });

  it("holds a field of the value under a second name", async () => {
    seedQueue();
    const { page, typed } = fakePage();
    const result = await run(page, [
      {
        type: "web_data_pick",
        folder: "outlook",
        index: "1",
        varName: "un",
        valueVar: "pw",
        path: "password",
      },
      { type: "web_input", selector: "#user", text: "{un}" },
      { type: "web_input", selector: "#pass", text: "{pw}" },
    ]);

    expect(result.ok).toBe(true);
    expect(typed.map((entry) => entry.text)).toEqual(["jaclee324", "p1"]);
  });

  it("moves the queue on once the record it took is deleted", async () => {
    seedQueue();
    const { page, typed } = fakePage();
    const first = await run(page, [
      { type: "web_data_pick", folder: "outlook", varName: "un" },
      { type: "web_data_delete", folder: "outlook", key: "{un}" },
    ]);
    expect(first.ok).toBe(true);
    expect(readDataRef("outlook.luckycee23")).toBeNull();

    const second = await run(page, [
      { type: "web_data_pick", folder: "outlook", varName: "un" },
      { type: "web_input", selector: "#user", text: "{un}" },
    ]);
    expect(second.ok).toBe(true);
    expect(typed.map((entry) => entry.text)).toEqual(["jaclee324"]);
  });

  it("takes the position from a name the round set", async () => {
    seedQueue();
    const { page, typed } = fakePage();
    const result = await run(page, [
      { type: "web_set", vars: [{ name: "i", value: "1" }] },
      { type: "web_data_pick", folder: "outlook", index: "{i}", varName: "un" },
      { type: "web_input", selector: "#user", text: "{un}" },
    ]);

    expect(result.ok).toBe(true);
    expect(typed.map((entry) => entry.text)).toEqual(["jaclee324"]);
  });

  it("fails on a position the folder has run out of, and carries on when optional", async () => {
    seedQueue();
    const { page } = fakePage();
    const strict = await run(page, [
      { type: "web_data_pick", folder: "outlook", index: "2", varName: "un" },
    ]);
    expect(strict.ok).toBe(false);
    expect(strict.logs[0].error).toBe("outlook holds nothing at position 2");

    const lenient = await run(page, [
      { type: "web_data_pick", folder: "outlook", index: "2", varName: "un", optional: true },
      { type: "web_delay", waitMs: 0 },
    ]);
    expect(lenient.ok).toBe(true);
    expect(lenient.logs[0].outcome).toContain("carried on");
  });

  it("refuses a position that is not one", async () => {
    seedQueue();
    const { page } = fakePage();
    const result = await run(page, [
      { type: "web_data_pick", folder: "outlook", index: "first", varName: "un" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.logs[0].error).toContain("`first` is not a position in the folder");
  });
});

describe("web_data_delete", () => {
  it("removes a field, and fails on one that was never there", async () => {
    seedExample();
    const { page } = fakePage();

    const removed = await run(page, [
      { type: "web_data_delete", folder: "example", key: "email", path: "password" },
    ]);
    expect(removed.ok).toBe(true);
    expect(readDataRef("example.email.password")).toBeNull();
    expect(readDataRef("example.email.other")).toBe("othervalue");

    const again = await run(page, [
      { type: "web_data_delete", folder: "example", key: "email", path: "password" },
    ]);
    expect(again.ok).toBe(false);
    expect(again.logs[0].error).toContain("nothing is stored at");
  });

  it("removes the whole record when no field is named", async () => {
    seedExample();
    const { page } = fakePage();
    const result = await run(page, [
      { type: "web_data_delete", folder: "example", key: "email" },
    ]);

    expect(result.ok).toBe(true);
    expect(readDataRef("example.email")).toBeNull();
  });
});
