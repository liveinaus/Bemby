import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "../jobs/paths";
import { ssrfSafeFetch } from "./safeFetch";

// Where a random profile photo comes from. Two sources, because neither covers every setup:
// a local pool works offline and behind a filtered network, and the online styles need no
// preparation at all. A bulk run can take either or fall back from one to the other.

export type AvatarSourceMode = "pool" | "online" | "any";

export type AvatarPick = {
  buffer: Buffer;
  filename: string;
  /** Where it came from, shown against each account in the batch. */
  source: string;
};

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** Telegram re-encodes what it is given, so this only has to stop absurd uploads. */
export const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

/** Images dropped in here are the offline source. Created on demand, never written to by us. */
export function avatarPoolDir(): string {
  return process.env.BEMBY_AVATAR_DIR || path.join(dataDir(), "avatars");
}

/** Absolute paths of every usable image in the pool, sorted for a stable order. */
export function listAvatarPool(): string[] {
  const dir = avatarPoolDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // no pool directory yet
  }
  return names
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        const stat = fs.statSync(file);
        return stat.isFile() && stat.size > 0 && stat.size <= MAX_AVATAR_BYTES;
      } catch {
        return false;
      }
    });
}

/**
 * DiceBear's styles differ enough from each other that a batch drawn across them does not
 * read as one generator's output, which is the point of picking a style per account rather
 * than per batch. The purely abstract styles (rings, shapes, glass) are left out: they make
 * poor profile photos.
 */
const ONLINE_STYLES = [
  "adventurer",
  "avataaars",
  "big-ears",
  "big-smile",
  "bottts",
  "croodles",
  "fun-emoji",
  "lorelei",
  "micah",
  "miniavs",
  "notionists",
  "open-peeps",
  "personas",
  "pixel-art",
  "thumbs",
] as const;

/**
 * Overridable because api.dicebear.com is not reachable everywhere this runs. A replacement
 * takes the same {style} and {seed} placeholders; anything without them is used as-is.
 */
function onlineUrlTemplate(): string {
  return (
    process.env.BEMBY_AVATAR_URL ||
    "https://api.dicebear.com/9.x/{style}/png?seed={seed}&size=512"
  );
}

function randomOf<T>(items: readonly T[]): T {
  return items[crypto.randomInt(items.length)];
}

/** Magic bytes, so a source that answers with an error page is caught before Telegram sees it. */
function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const webp =
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP";
  return jpeg || png || webp;
}

export function assertUsableImage(buf: Buffer): void {
  if (!buf.length) throw new Error("Image is empty");
  if (buf.length > MAX_AVATAR_BYTES) {
    throw new Error(
      `Image is larger than ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)} MB`,
    );
  }
  if (!looksLikeImage(buf)) {
    throw new Error("Not a JPEG, PNG or WebP image");
  }
}

/**
 * One image from the pool. `used` holds the paths already handed out in this run so a batch
 * spreads across the pool instead of repeating; once every file has been used it starts over,
 * which is the only option when there are fewer images than accounts.
 */
export function pickFromPool(used: Set<string>): AvatarPick {
  const pool = listAvatarPool();
  if (!pool.length) {
    throw new Error(
      `No images in the avatar pool (${avatarPoolDir()}) -- add .jpg, .png or .webp files`,
    );
  }
  let candidates = pool.filter((file) => !used.has(file));
  if (!candidates.length) {
    used.clear();
    candidates = pool;
  }
  const file = randomOf(candidates);
  used.add(file);
  const buffer = fs.readFileSync(file);
  assertUsableImage(buffer);
  return { buffer, filename: path.basename(file), source: "pool" };
}

/** One image from a random online style, seeded so two accounts never get the same face. */
export async function pickFromOnline(): Promise<AvatarPick> {
  const style = randomOf(ONLINE_STYLES);
  const seed = crypto.randomBytes(8).toString("hex");
  const url = onlineUrlTemplate()
    .replace("{style}", encodeURIComponent(style))
    .replace("{seed}", encodeURIComponent(seed));

  const resp = await ssrfSafeFetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`Avatar service answered ${resp.status}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  assertUsableImage(buffer);
  return { buffer, filename: `${style}-${seed}.png`, source: `online/${style}` };
}

/**
 * A random avatar from whichever source the caller asked for. "any" prefers the pool, since
 * a curated image beats a generated one, and falls back to online when the pool is empty.
 */
export async function pickRandomAvatar(
  mode: AvatarSourceMode,
  used: Set<string>,
): Promise<AvatarPick> {
  if (mode === "pool") return pickFromPool(used);
  if (mode === "online") return pickFromOnline();
  try {
    return pickFromPool(used);
  } catch {
    return pickFromOnline();
  }
}

export type AvatarPoolStatus = {
  dir: string;
  count: number;
  online: boolean;
  styles: number;
};

export function avatarPoolStatus(): AvatarPoolStatus {
  return {
    dir: avatarPoolDir(),
    count: listAvatarPool().length,
    online: true,
    styles: ONLINE_STYLES.length,
  };
}
