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
  isPoolImageName,
  listAvatarPool,
  pickFromPool,
  poolImageExtensions,
  saveToAvatarPool,
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

// Uploading into the pool. The names come out of a ZIP somebody made on their own machine,
// so none of them can be trusted as a path.
describe("saveToAvatarPool", () => {
  it("writes the image into the pool under its own name", () => {
    const name = saveToAvatarPool("face.png", PNG);
    expect(name).toBe("face.png");
    expect(listAvatarPool()).toEqual([path.join(pool, "face.png")]);
  });

  it("creates the pool directory when it is the first upload", () => {
    rmSync(pool, { recursive: true, force: true });
    saveToAvatarPool("first.png", PNG);
    expect(listAvatarPool()).toHaveLength(1);
  });

  it("flattens a path in the archive rather than following it", () => {
    const name = saveToAvatarPool("holiday/2019/img.png", PNG);
    expect(name).toBe("holiday-2019-img.png");
    expect(listAvatarPool()).toEqual([path.join(pool, "holiday-2019-img.png")]);
  });

  it("cannot be talked into writing outside the pool", () => {
    const name = saveToAvatarPool("../../etc/cron.d/evil.png", PNG);
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
    expect(listAvatarPool()).toEqual([path.join(pool, name)]);
  });

  it("takes a Windows archiver's backslashes as separators too", () => {
    expect(saveToAvatarPool("photos\\2020\\a.png", PNG)).toBe("photos-2020-a.png");
  });

  it("keeps both files when two archives hold the same name", () => {
    expect(saveToAvatarPool("IMG_0001.jpg", JPEG)).toBe("IMG_0001.jpg");
    expect(saveToAvatarPool("IMG_0001.jpg", JPEG)).toBe("IMG_0001-2.jpg");
    expect(saveToAvatarPool("IMG_0001.jpg", JPEG)).toBe("IMG_0001-3.jpg");
    expect(listAvatarPool()).toHaveLength(3);
  });

  it("replaces the characters a filename should not carry", () => {
    const name = saveToAvatarPool("我的 photo (1)!.png", PNG);
    expect(name).toMatch(/^[a-zA-Z0-9._-]+\.png$/);
  });

  it("falls back to a name of its own when nothing usable is left", () => {
    expect(saveToAvatarPool("...", PNG)).toBe("avatar.jpg");
  });

  it("refuses something that is not an image, before it is written", () => {
    expect(() => saveToAvatarPool("notes.png", Buffer.from("<html>nope</html>"))).toThrow(
      /Not a JPEG, PNG or WebP/,
    );
    expect(listAvatarPool()).toEqual([]);
  });

  it("shows up in the count the panel reads", () => {
    saveToAvatarPool("a.png", PNG);
    saveToAvatarPool("b.jpg", JPEG);
    expect(avatarPoolStatus().count).toBe(2);
    expect(avatarPoolStatus().dir).toBe(avatarPoolDir());
  });
});

describe("isPoolImageName", () => {
  it("takes the extensions the pool reads", () => {
    for (const extension of poolImageExtensions()) {
      expect(isPoolImageName(`photo${extension}`)).toBe(true);
    }
    expect(isPoolImageName("PHOTO.JPG")).toBe(true);
  });

  it("leaves everything else in the archive alone", () => {
    expect(isPoolImageName("notes.txt")).toBe(false);
    expect(isPoolImageName("photos/")).toBe(false);
    expect(isPoolImageName(".DS_Store")).toBe(false);
    expect(isPoolImageName("photos/.hidden.png")).toBe(false);
    expect(isPoolImageName("__MACOSX/._face.png")).toBe(false);
  });

  it("looks at the last segment, not the folders above it", () => {
    expect(isPoolImageName("holiday/2019/img.png")).toBe(true);
    expect(isPoolImageName("img.png/notes.txt")).toBe(false);
  });
});
