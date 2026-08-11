// The avatar pool is operator-supplied, so everything about it is untrusted: a directory
// that does not exist, files that are not images, and a pool smaller than the batch using
// it. A bulk run must survive all three rather than stopping partway through.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import {
  assertUsableImage,
  avatarPoolDir,
  avatarPoolStatus,
  listAvatarPool,
  pickFromPool,
} from "../tg/avatarSource";

const root = mkdtempSync(path.join(os.tmpdir(), "avatars-"));
const pool = path.join(root, "avatars");

// The smallest byte sequences that carry each format's magic number
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]);

beforeEach(() => {
  // dataDir() is read from DB_PATH on every call, so the pool can be pointed here
  process.env.DB_PATH = path.join(root, "bemby.db");
  delete process.env.BEMBY_AVATAR_DIR;
  rmSync(pool, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

function seedPool(files: Record<string, Buffer>) {
  mkdirSync(pool, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(pool, name), body);
  }
}

describe("avatarPoolDir", () => {
  it("sits beside the database by default", () => {
    expect(avatarPoolDir()).toBe(pool);
  });

  it("is overridable, for a pool held outside the data volume", () => {
    process.env.BEMBY_AVATAR_DIR = "/srv/faces";
    expect(avatarPoolDir()).toBe("/srv/faces");
  });
});

describe("listAvatarPool", () => {
  it("returns nothing when the directory has never been created", () => {
    expect(listAvatarPool()).toEqual([]);
  });

  it("keeps images and ignores everything else", () => {
    seedPool({
      "a.png": PNG,
      "b.JPG": JPEG,
      "notes.txt": Buffer.from("not an image"),
      "empty.png": Buffer.alloc(0),
    });
    expect(listAvatarPool().map((f) => path.basename(f))).toEqual(["a.png", "b.JPG"]);
  });
});

describe("pickFromPool", () => {
  it("explains where to put images when the pool is empty", () => {
    expect(() => pickFromPool(new Set())).toThrow(/avatar pool/i);
  });

  it("hands out every image before repeating one", () => {
    seedPool({ "a.png": PNG, "b.png": PNG, "c.png": PNG });
    const used = new Set<string>();
    const picked = [pickFromPool(used), pickFromPool(used), pickFromPool(used)];
    expect(new Set(picked.map((p) => p.filename)).size).toBe(3);
  });

  it("starts over when the batch is larger than the pool", () => {
    seedPool({ "only.png": PNG });
    const used = new Set<string>();
    expect(pickFromPool(used).filename).toBe("only.png");
    expect(pickFromPool(used).filename).toBe("only.png"); // no throw
  });
});

describe("assertUsableImage", () => {
  it("accepts the formats Telegram takes", () => {
    expect(() => assertUsableImage(PNG)).not.toThrow();
    expect(() => assertUsableImage(JPEG)).not.toThrow();
  });

  it("rejects an error page served in place of an image", () => {
    expect(() => assertUsableImage(Buffer.from("<html>rate limited</html>"))).toThrow(
      /JPEG, PNG or WebP/,
    );
  });

  it("rejects an empty body", () => {
    expect(() => assertUsableImage(Buffer.alloc(0))).toThrow(/empty/i);
  });
});

describe("avatarPoolStatus", () => {
  it("reports the directory and how much is in it", () => {
    seedPool({ "a.png": PNG });
    const status = avatarPoolStatus();
    expect(status).toMatchObject({ dir: pool, count: 1, online: true });
    expect(status.styles).toBeGreaterThan(5);
  });
});
