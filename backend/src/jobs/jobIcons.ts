import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "./paths";

// A job's icon is either one of the icon-font names the panel offers ("fa-solid fa-gift")
// or a file an operator uploaded, referenced as "custom:<file>". The reference is what gets
// stored; the files live here, on the data volume, so they survive a restart and an upgrade.

export const CUSTOM_PREFIX = "custom:";
export const MAX_ICON_BYTES = 512 * 1024;
/** Enough for any sensible set, and a bound on what the list endpoint can return at once. */
export const MAX_ICON_COUNT = 200;

const EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export function jobIconDir(): string {
  return process.env.BEMBY_JOB_ICON_DIR || path.join(dataDir(), "job-icons");
}

/** Rejects anything that could climb out of the icon directory. */
function isSafeName(name: string): boolean {
  return (
    Boolean(name) &&
    name === path.basename(name) &&
    !name.startsWith(".") &&
    name.length <= 120 &&
    Object.prototype.hasOwnProperty.call(EXTENSIONS, path.extname(name).toLowerCase())
  );
}

export type JobIconFile = { name: string; mime: string; size: number };

export function listJobIcons(): JobIconFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(jobIconDir());
  } catch {
    return []; // never uploaded anything yet
  }
  return names
    .filter(isSafeName)
    .sort()
    .slice(0, MAX_ICON_COUNT)
    .flatMap((name) => {
      try {
        const stat = fs.statSync(path.join(jobIconDir(), name));
        if (!stat.isFile() || !stat.size || stat.size > MAX_ICON_BYTES) return [];
        return [
          { name, mime: EXTENSIONS[path.extname(name).toLowerCase()], size: stat.size },
        ];
      } catch {
        return [];
      }
    });
}

/** File bytes as a data URL, which is how the panel renders them -- see the route. */
export function jobIconDataUrl(file: JobIconFile): string | null {
  try {
    const bytes = fs.readFileSync(path.join(jobIconDir(), file.name));
    return `data:${file.mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

function sniffExtension(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return ".webp";
  }
  // SVG is text, and may open with a comment, an XML declaration or a doctype
  const head = buf.toString("utf8", 0, Math.min(buf.length, 1024)).trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!--")) {
    return head.includes("<svg") ? ".svg" : null;
  }
  return null;
}

/**
 * Stores an uploaded icon under a content-hashed name, so the same file uploaded twice is
 * one file and a reference can never point at different bytes later. The extension comes
 * from the content rather than the supplied filename, which is the caller's claim.
 */
export function saveJobIcon(buffer: Buffer): JobIconFile {
  if (!buffer.length) throw new Error("Icon is empty");
  if (buffer.length > MAX_ICON_BYTES) {
    throw new Error(`Icon is larger than ${Math.round(MAX_ICON_BYTES / 1024)} KB`);
  }
  const ext = sniffExtension(buffer);
  if (!ext) throw new Error("Not a PNG, JPEG, WebP or SVG image");
  if (listJobIcons().length >= MAX_ICON_COUNT) {
    throw new Error(`The icon library is full (${MAX_ICON_COUNT} icons)`);
  }

  const dir = jobIconDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16)}${ext}`;
  fs.writeFileSync(path.join(dir, name), buffer);
  return { name, mime: EXTENSIONS[ext], size: buffer.length };
}

export function deleteJobIcon(name: string): boolean {
  if (!isSafeName(name)) return false;
  try {
    fs.unlinkSync(path.join(jobIconDir(), name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an icon reference is one this panel will store. Font names are taken on trust --
 * they are rendered as a CSS class, never as a path -- but a custom reference has to name a
 * file that is actually there, or every list showing that job renders a hole.
 */
export function isKnownIcon(icon: string): boolean {
  if (!icon) return false;
  if (icon.startsWith(CUSTOM_PREFIX)) {
    const name = icon.slice(CUSTOM_PREFIX.length);
    return isSafeName(name) && listJobIcons().some((f) => f.name === name);
  }
  // Icon-font class names: letters, digits, spaces and dashes, nothing that could
  // break out of a class attribute
  return /^[a-zA-Z0-9 _-]{1,60}$/.test(icon);
}
