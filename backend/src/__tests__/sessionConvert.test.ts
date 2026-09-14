// Card parsing and the Telethon-session -> GramJS-string-session re-encoding. The encoder is
// the load-bearing part: a byte layout that GramJS cannot decode means every imported account
// fails to connect, so it is checked by round-tripping through GramJS's own decoder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { StringSession } from "telegram/sessions";
import {
  parseCardInput,
} from "../jobs/sessionImport";
import {
  telethonSessionToStringSession,
  parseConvertedArchive,
  normaliseConverterBase,
} from "../jobs/sessionConvert";

const UUID = "50dc50fb-6425-4118-b4b2-71e62102ffe5";

describe("parseCardInput", () => {
  it("parses phone----url lines and keeps the phone", () => {
    const { lines, errors } = parseCardInput(
      `+15485080901----https://cards.example.com/getcode?id=${UUID}`,
    );
    expect(errors).toEqual([]);
    expect(lines).toEqual([
      {
        phoneNumber: "+15485080901",
        apiUrl: `https://cards.example.com/getcode?id=${UUID}`,
        line: `+15485080901----https://cards.example.com/getcode?id=${UUID}`,
      },
    ]);
  });

  it("accepts a bare URL or bare UUID (phone is optional)", () => {
    const { lines, errors } = parseCardInput(
      `https://x/getcode?id=${UUID}\n${UUID}`,
    );
    expect(errors).toEqual([]);
    expect(lines.map((l) => l.phoneNumber)).toEqual(["", ""]);
    expect(lines.map((l) => l.apiUrl)).toEqual([`https://x/getcode?id=${UUID}`, UUID]);
  });

  it("rejects a line with no card UUID", () => {
    const { lines, errors } = parseCardInput("+15485080901----https://x/getcode?id=notauuid");
    expect(lines).toEqual([]);
    expect(errors[0]).toContain("No card UUID");
  });
});

describe("normaliseConverterBase", () => {
  it("keeps only scheme+host, dropping any path or trailing slash", () => {
    expect(normaliseConverterBase("https://conv.example.com/")).toBe(
      "https://conv.example.com",
    );
    expect(normaliseConverterBase("https://conv.example.com/api/x")).toBe(
      "https://conv.example.com",
    );
  });

  it("defaults a bare host to https", () => {
    expect(normaliseConverterBase("conv.example.com")).toBe(
      "https://conv.example.com",
    );
  });

  it("rejects an empty or non-http URL", () => {
    expect(() => normaliseConverterBase("")).toThrow(/required/i);
    expect(() => normaliseConverterBase("ftp://x")).toThrow(/http/i);
  });
});

/** Build a minimal Telethon .session SQLite file, as the converter delivers. */
function makeTelethonSession(
  dcId: number,
  server: string,
  port: number,
  authKey: Buffer,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bemby-test-"));
  const file = path.join(dir, "acct.session");
  const db = new Database(file);
  db.exec(
    "CREATE TABLE sessions (dc_id INTEGER, server_address TEXT, port INTEGER, auth_key BLOB, takeout_id INTEGER, tmp_auth_key BLOB)",
  );
  db.prepare(
    "INSERT INTO sessions (dc_id, server_address, port, auth_key) VALUES (?, ?, ?, ?)",
  ).run(dcId, server, port, authKey);
  db.close();
  return file;
}

describe("telethonSessionToStringSession", () => {
  it("re-encodes into a string GramJS can decode back to the same key", () => {
    const authKey = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) authKey[i] = (i * 7 + 3) & 0xff;
    const file = makeTelethonSession(2, "149.154.167.51", 443, authKey);
    try {
      const { sessionString, dcId } = telethonSessionToStringSession(
        fs.readFileSync(file),
      );
      expect(dcId).toBe(2);
      expect(sessionString[0]).toBe("1");

      const s = new StringSession(sessionString);
      // GramJS's decoder stores the decoded parts on these private fields; _key is the raw
      // auth-key buffer it read back out.
      expect((s as any).dcId).toBe(2);
      expect((s as any).serverAddress).toBe("149.154.167.51");
      expect((s as any).port).toBe(443);
      expect(Buffer.from((s as any)._key).equals(authKey)).toBe(true);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("rejects a session with a wrong-length auth key", () => {
    const file = makeTelethonSession(1, "1.2.3.4", 443, Buffer.alloc(100));
    try {
      expect(() => telethonSessionToStringSession(fs.readFileSync(file))).toThrow(
        /auth key/i,
      );
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe("parseConvertedArchive", () => {
  it("reports a stem missing its .session rather than dropping it", () => {
    // A minimal zip with only a .json entry for one phone; readZip handles stored entries.
    const zip = buildZip([
      {
        name: "+1999.json",
        data: Buffer.from(
          JSON.stringify({ phone: "+1999", api_id: 2040, api_hash: "x".repeat(32) }),
        ),
      },
    ]);
    const { accounts, errors } = parseConvertedArchive(zip);
    expect(accounts).toEqual([]);
    expect(errors[0].phone).toBe("+1999");
    expect(errors[0].error).toContain("missing .session");
  });
});

/** Tiny stored-only ZIP writer, enough for readZip in tests (no compression). */
function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const crc32 = (buf: Buffer): number => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, f.data]);
    locals.push(local);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10); // stored
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const localData = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralDir, eocd]);
}
