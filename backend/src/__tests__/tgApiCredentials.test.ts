// Fetching an account's own API credentials off my.telegram.org: reading the login code out of
// a service message, and writing the pair the site hands back onto the account. Neither needs a
// browser, and both are where the flow goes wrong -- a code read out of the wrong number in the
// message, or a selector that has drifted saving a label onto an account as its api_hash.

let testDb!: InstanceType<typeof Database>;
let dataStoreOn = true;
const writes: Array<{ folder: string; key: string; path: string; value: unknown }> = [];

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("../db/dataStore", () => ({
  isDataStoreEnabled: () => dataStoreOn,
  dataStoreOffReason: () => "the data store is switched off",
  writeDataValue: (folder: string, key: string, path: string, value: unknown) => {
    writes.push({ folder, key, path, value });
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  extractLoginCode,
  maskApiHash,
  parseTgApiPair,
  saveAccountApiCredentials,
} from "../jobs/tgApiCredentials";

const HASH = "0123456789abcdef0123456789abcdef";

const SCHEMA = `
  CREATE TABLE tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL DEFAULT '',
    phone_number   TEXT    NOT NULL DEFAULT '',
    api_id         INTEGER,
    api_hash       TEXT,
    session_string TEXT
  );
`;

function insertAccount(fields: Partial<{
  name: string;
  phone: string;
  apiId: number | null;
  session: string | null;
}> = {}): number {
  const { lastInsertRowid } = testDb
    .prepare(
      "INSERT INTO tg_accounts (name, phone_number, api_id, session_string) VALUES (?, ?, ?, ?)",
    )
    .run(
      fields.name ?? "acc",
      fields.phone ?? "+61412345678",
      fields.apiId ?? null,
      fields.session ?? null,
    );
  return Number(lastInsertRowid);
}

function accountRow(id: number) {
  return testDb
    .prepare("SELECT api_id, api_hash FROM tg_accounts WHERE id = ?")
    .get(id) as { api_id: number | null; api_hash: string | null };
}

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);
  dataStoreOn = true;
  writes.length = 0;
});

describe("extractLoginCode", () => {
  it("takes the token my.telegram.org actually sends, not the word after the first \"code\"", () => {
    // Verbatim shape of the service message, whose opening sentence also says "code"
    const text =
      "Web login code. Dear 小明, we received a request from your account to log in on " +
      "my.telegram.org. This is your login code: Q6mq_4re-8s Do not give this code to anyone, " +
      "even if they say they are from Telegram.";
    expect(extractLoginCode(text)).toBe("Q6mq_4re-8s");
  });

  it("keeps a leading underscore, which a code is as likely to start with as not", () => {
    // Verbatim, newline and all: the code is handed over after the colon on its own line
    const text =
      "Web login code. Dear Luna, we received a request from your account to log in on " +
      "my.telegram.org. This is your login code:\n_b6cgbgXyH4\n\nDo not give this code to " +
      "anyone, even if they say they're from Telegram! This code can be used to delete your " +
      "Telegram account.";
    expect(extractLoginCode(text)).toBe("_b6cgbgXyH4");
  });

  it("takes a token with no separator, so long as it mixes letters and digits", () => {
    expect(extractLoginCode("This is your login code: Ab3xY9zQ Do not give it away")).toBe(
      "Ab3xY9zQ",
    );
  });

  it("takes the digit code a phone login gets", () => {
    const text =
      "Web login code: 47281\n\nDear Sam, we received a request from your account to log in " +
      "on my.telegram.org. Do not give this code to anyone.";
    expect(extractLoginCode(text)).toBe("47281");
  });

  it("prefers the run next to the word code over any other number", () => {
    // The wording carries a year and a support number; neither is the code
    const text = "Telegram code 903214. Ref 2024 my.telegram.org";
    expect(extractLoginCode(text)).toBe("903214");
  });

  it("falls back to any 5-6 digit run when the wording is translated", () => {
    expect(extractLoginCode("登录代码：52901，请勿转发给任何人")).toBe("52901");
  });

  it("leaves longer digit runs alone, so an id is not read as a code", () => {
    expect(extractLoginCode("session 1234567890 opened")).toBeNull();
  });

  it("takes the caller's expression, keeping capture group 1", () => {
    expect(extractLoginCode("your key is AB-9931", "is ([A-Z]{2}-\\d{4})")).toBe("AB-9931");
  });

  it("returns nothing when the message holds no code at all", () => {
    expect(extractLoginCode("Someone signed in from a new device")).toBeNull();
  });

  it("reads nothing out of the other service messages an account gets", () => {
    // These sit in the same chat, and one of them is the newest message often enough
    expect(
      extractLoginCode(
        "Two-Step Verification settings changed. Dear DDFF66, your Two-Step Verification " +
          "password and/or email were changed on 27/07/2026 at 02:06:52 UTC.",
      ),
    ).toBeNull();
    expect(
      extractLoginCode(
        "New passkey added. Dear DDFF66, a new passkey was created for your account on " +
          "26/07/2026 at 12:51:11 UTC. Passkey provider: N/A Device: myApp",
      ),
    ).toBeNull();
  });
});

describe("parseTgApiPair", () => {
  it("reads a pair as my.telegram.org writes it", () => {
    expect(parseTgApiPair(" 2040 ", HASH.toUpperCase())).toEqual({
      apiId: 2040,
      apiHash: HASH,
    });
  });

  it("refuses a label read in place of the api_id", () => {
    // What a drifted selector actually returns: the field's caption
    expect(() => parseTgApiPair("App api_id:", HASH)).toThrow(/not an api_id/);
  });

  it("refuses a hash that is not 32 hexadecimal characters", () => {
    expect(() => parseTgApiPair("2040", "not-a-hash")).toThrow(/not an api_hash/);
    expect(() => parseTgApiPair("2040", HASH.slice(0, 31))).toThrow(/not an api_hash/);
  });
});

describe("maskApiHash", () => {
  it("keeps enough to tell two apart without writing the login down", () => {
    const masked = maskApiHash(HASH);
    expect(masked.startsWith("0123")).toBe(true);
    expect(masked.endsWith("cdef")).toBe(true);
    expect(masked).not.toContain(HASH.slice(4, 12));
    expect(masked).toHaveLength(HASH.length);
  });
});

describe("saveAccountApiCredentials", () => {
  it("writes the pair onto the account", () => {
    const id = insertAccount();
    const { summary } = saveAccountApiCredentials({ accountId: id, apiId: "2040", apiHash: HASH });
    expect(accountRow(id)).toEqual({ api_id: 2040, api_hash: HASH });
    expect(summary).toContain("2040");
    // The hash is reported masked, never in full
    expect(summary).not.toContain(HASH);
  });

  it("keeps a copy in the data store under the account's phone when a folder is named", () => {
    const id = insertAccount({ phone: "+61400000001" });
    saveAccountApiCredentials({ accountId: id, apiId: "2040", apiHash: HASH, folder: "tgApi" });
    expect(writes).toEqual([
      {
        folder: "tgApi",
        key: "+61400000001",
        path: "",
        value: { apiId: 2040, apiHash: HASH, phone: "+61400000001" },
      },
    ]);
  });

  it("takes a record key of its own over the phone number", () => {
    const id = insertAccount();
    saveAccountApiCredentials({
      accountId: id,
      apiId: "2040",
      apiHash: HASH,
      folder: "tgApi",
      key: "acc-1",
    });
    expect(writes[0].key).toBe("acc-1");
  });

  it("writes nothing at all when the store is off and a folder was named", () => {
    // Failing halfway would leave the account holding credentials nothing has a record of
    const id = insertAccount();
    dataStoreOn = false;
    expect(() =>
      saveAccountApiCredentials({ accountId: id, apiId: "2040", apiHash: HASH, folder: "tgApi" }),
    ).toThrow(/switched off/);
    expect(accountRow(id)).toEqual({ api_id: null, api_hash: null });
  });

  it("leaves the account alone when the pair does not look like one", () => {
    const id = insertAccount({ apiId: 111 });
    expect(() =>
      saveAccountApiCredentials({ accountId: id, apiId: "2040", apiHash: "App api_hash:" }),
    ).toThrow(/not an api_hash/);
    expect(accountRow(id).api_id).toBe(111);
  });

  it("says which pair was replaced, and that the session was made under it", () => {
    const id = insertAccount({ apiId: 111, session: "1AaBbCc" });
    const { summary } = saveAccountApiCredentials({
      accountId: id,
      apiId: "2040",
      apiHash: HASH,
    });
    expect(summary).toContain("replacing 111");
    expect(summary).toMatch(/sign in again/);
  });

  it("reports an account that has since been deleted rather than writing nothing quietly", () => {
    expect(() =>
      saveAccountApiCredentials({ accountId: 999, apiId: "2040", apiHash: HASH }),
    ).toThrow(/no longer there/);
  });
});
