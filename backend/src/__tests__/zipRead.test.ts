// The ZIP reader behind the avatar-pool upload. Archives are built here byte by byte rather
// than fixtures on disk, so what each test is about -- a method, a flag, a declared size --
// is visible in the test itself.
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { looksLikeZip, readZip } from "../system/zipRead";

const LIMITS = { maxEntryBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxEntries: 10 };

type Spec = {
  name: string;
  data: Buffer;
  /** 0 stored, 8 deflated. */
  method?: number;
  flags?: number;
  /** Overrides the declared uncompressed size, for the archives that lie. */
  declaredSize?: number;
};

/** A minimal but real ZIP: local headers, then a central directory, then the EOCD. */
function makeZip(specs: Spec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const spec of specs) {
    const method = spec.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(spec.data) : spec.data;
    const name = Buffer.from(spec.name, "utf8");
    const declared = spec.declaredSize ?? spec.data.length;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(spec.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // crc, not checked by the reader
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(spec.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBytes, eocd]);
}

const text = (s: string) => Buffer.from(s, "utf8");

describe("looksLikeZip", () => {
  it("knows an archive by its magic bytes", () => {
    expect(looksLikeZip(makeZip([{ name: "a.txt", data: text("hello") }]))).toBe(true);
  });

  it("knows an empty archive", () => {
    expect(looksLikeZip(makeZip([]))).toBe(true);
  });

  it("does not mistake a JPEG for one", () => {
    expect(looksLikeZip(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe(false);
  });

  it("does not fall over on a few stray bytes", () => {
    expect(looksLikeZip(Buffer.from([0x50]))).toBe(false);
  });
});

describe("readZip", () => {
  it("reads a deflated entry back byte for byte", () => {
    const data = Buffer.from("a".repeat(5000), "utf8");
    const out = readZip(makeZip([{ name: "big.txt", data }]), LIMITS);

    expect(out.skipped).toEqual([]);
    expect(out.files).toHaveLength(1);
    expect(out.files[0].name).toBe("big.txt");
    expect(out.files[0].data.equals(data)).toBe(true);
  });

  it("reads a stored entry", () => {
    const out = readZip(makeZip([{ name: "s.txt", data: text("stored"), method: 0 }]), LIMITS);
    expect(out.files[0].data.toString()).toBe("stored");
  });

  it("keeps several entries in the archive's own order", () => {
    const out = readZip(
      makeZip([
        { name: "one.png", data: text("1") },
        { name: "two.png", data: text("22"), method: 0 },
        { name: "three.png", data: text("333") },
      ]),
      LIMITS,
    );
    expect(out.files.map((f) => f.name)).toEqual(["one.png", "two.png", "three.png"]);
  });

  it("hands back the name as written, path and all, for the caller to flatten", () => {
    const out = readZip(makeZip([{ name: "holiday/2019/img.png", data: text("x") }]), LIMITS);
    expect(out.files[0].name).toBe("holiday/2019/img.png");
  });

  it("passes over the folder entries an archiver adds", () => {
    const out = readZip(
      makeZip([
        { name: "photos/", data: Buffer.alloc(0), method: 0 },
        { name: "photos/a.png", data: text("a") },
      ]),
      LIMITS,
    );
    expect(out.files.map((f) => f.name)).toEqual(["photos/a.png"]);
    expect(out.skipped).toEqual([]);
  });

  it("turns down a password-protected entry by name, and keeps the rest", () => {
    const out = readZip(
      makeZip([
        { name: "locked.png", data: text("secret"), flags: 0x1 },
        { name: "open.png", data: text("fine") },
      ]),
      LIMITS,
    );
    expect(out.files.map((f) => f.name)).toEqual(["open.png"]);
    expect(out.skipped).toEqual([{ name: "locked.png", why: "the entry is password-protected" }]);
  });

  it("turns down a compression method it cannot read", () => {
    const out = readZip(makeZip([{ name: "x.png", data: text("bz"), method: 12 }]), LIMITS);
    expect(out.files).toEqual([]);
    expect(out.skipped[0].why).toMatch(/method 12 is not supported/);
  });

  it("refuses an entry larger than the limit without inflating it", () => {
    // Declares 8 MB against a limit of 1 MB: the reader must go by the declaration, which is
    // what stops a bomb costing anything
    const out = readZip(
      makeZip([{ name: "bomb.png", data: text("x"), declaredSize: 8 * 1024 * 1024 }]),
      LIMITS,
    );
    expect(out.files).toEqual([]);
    expect(out.skipped[0].why).toMatch(/larger than 1 MB/);
  });

  it("stops at the total it was given, keeping what fitted", () => {
    const half = Buffer.alloc(600 * 1024, 0x61);
    const out = readZip(
      makeZip([
        { name: "a.png", data: half },
        { name: "b.png", data: half },
        { name: "c.png", data: half },
      ]),
      { ...LIMITS, maxTotalBytes: 1024 * 1024 },
    );
    expect(out.files.map((f) => f.name)).toEqual(["a.png"]);
    expect(out.skipped.map((s) => s.name)).toEqual(["b.png", "c.png"]);
    expect(out.skipped[0].why).toMatch(/more than 1 MB/);
  });

  it("stops at the entry count it was given", () => {
    const specs = Array.from({ length: 5 }, (_, i) => ({
      name: `img${i}.png`,
      data: text(String(i)),
    }));
    const out = readZip(makeZip(specs), { ...LIMITS, maxEntries: 3 });
    expect(out.files).toHaveLength(3);
    expect(out.skipped).toHaveLength(2);
    expect(out.skipped[0].why).toMatch(/more than 3 files/);
  });

  it("reports an entry whose declared size does not match what came out", () => {
    const out = readZip(makeZip([{ name: "odd.png", data: text("12345"), declaredSize: 4 }]), LIMITS);
    expect(out.files).toEqual([]);
    expect(out.skipped[0].why).toMatch(/does not match/);
  });

  it("refuses something that is not an archive at all", () => {
    expect(() => readZip(Buffer.from("just some text"), LIMITS)).toThrow(/Not a ZIP archive/);
  });

  it("refuses an archive whose directory is not there", () => {
    const zip = makeZip([{ name: "a.png", data: text("a") }]);
    // Keep the opening signature, lose the end of it
    expect(() => readZip(zip.subarray(0, 30), LIMITS)).toThrow(/end-of-directory/);
  });

  it("reads an empty archive as empty rather than failing", () => {
    const out = readZip(makeZip([]), LIMITS);
    expect(out.files).toEqual([]);
    expect(out.skipped).toEqual([]);
  });

  it("finds the directory behind a trailing comment", () => {
    const zip = makeZip([{ name: "a.png", data: text("a") }]);
    const comment = Buffer.from("a comment nobody reads");
    const commented = Buffer.concat([zip, comment]);
    // The EOCD is where it was; only its comment length has to say what follows it
    commented.writeUInt16LE(comment.length, zip.length - 22 + 20);
    expect(readZip(commented, LIMITS).files[0].name).toBe("a.png");
  });
});
