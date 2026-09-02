import zlib from "node:zlib";

/**
 * Reading a ZIP archive, kept dependency-free.
 *
 * Only what an upload of images needs: the central directory is walked, stored and deflated
 * entries are inflated with zlib, and everything else -- encryption, zip64, the compression
 * methods nobody has produced this century -- is refused by name rather than half-handled.
 * A file that cannot be read is reported alongside the ones that could, since an archive is
 * usually mostly fine and the point is to take what is usable.
 *
 * Every limit is enforced against the *declared* uncompressed size before a byte is
 * inflated, so an archive claiming a gigabyte per entry costs nothing to turn down.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The longest trailing comment a ZIP may carry, which is how far back the EOCD is hunted. */
const MAX_COMMENT = 0xffff;

/** Sizes at this value mean the real ones are in a zip64 extra field, which is not read. */
const ZIP64_MARKER = 0xffffffff;

export type ZipEntry = {
  /** The name as the archive gives it, path and all. Never used as a path by this module. */
  name: string;
  data: Buffer;
};

export type ZipSkipped = {
  name: string;
  why: string;
};

export type ZipLimits = {
  /** Largest uncompressed size for one entry. */
  maxEntryBytes: number;
  /** Largest uncompressed total across the archive. */
  maxTotalBytes: number;
  /** Most entries read; the rest are reported as skipped. */
  maxEntries: number;
};

export type ZipReadResult = {
  files: ZipEntry[];
  skipped: ZipSkipped[];
};

/** Whether these bytes open like a ZIP archive: "PK\x03\x04", or an empty one's "PK\x05\x06". */
export function looksLikeZip(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const sig = buf.readUInt32LE(0);
  return sig === LOCAL_SIGNATURE || sig === EOCD_SIGNATURE;
}

/**
 * The end-of-central-directory record, searched from the back.
 *
 * Backwards because a trailing comment may sit after it, and a byte pattern matching the
 * signature may sit inside the archive's data -- the last one that leaves room for the
 * record itself is the real one.
 */
function findEocd(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - MAX_COMMENT - 22);
  for (let at = buf.length - 22; at >= earliest; at--) {
    if (buf.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  return -1;
}

/** A directory entry, or one of the folders an archiver adds beside the real files. */
function isDirectoryName(name: string): boolean {
  return name.endsWith("/") || name.endsWith("\\");
}

function inflate(entryData: Buffer, method: number): Buffer {
  if (method === 0) return entryData;
  // Raw deflate: a ZIP entry carries the deflate stream with no zlib header around it
  return zlib.inflateRawSync(entryData);
}

/**
 * Reads every usable file out of an archive.
 *
 * Throws only when the whole thing is unreadable -- not a ZIP, or a truncated central
 * directory. A single bad entry is a `skipped` row.
 */
export function readZip(buf: Buffer, limits: ZipLimits): ZipReadResult {
  if (!looksLikeZip(buf)) throw new Error("Not a ZIP archive");

  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("The ZIP archive has no end-of-directory record");

  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralAt = buf.readUInt32LE(eocd + 16);
  if (centralAt === ZIP64_MARKER || centralSize === ZIP64_MARKER || entryCount === 0xffff) {
    throw new Error("zip64 archives are not supported -- split it or use a smaller archive");
  }
  if (centralAt + centralSize > buf.length) {
    throw new Error("The ZIP archive is truncated");
  }

  const files: ZipEntry[] = [];
  const skipped: ZipSkipped[] = [];
  let total = 0;
  let at = centralAt;

  for (let i = 0; i < entryCount; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      skipped.push({ name: `(entry ${i + 1})`, why: "the archive's directory is malformed" });
      break;
    }
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const uncompressedSize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;

    if (isDirectoryName(name) || (uncompressedSize === 0 && compressedSize === 0)) continue;

    if (files.length >= limits.maxEntries) {
      skipped.push({ name, why: `more than ${limits.maxEntries} files in the archive` });
      continue;
    }
    // Bit 0 is "encrypted"; the strong-encryption bit (6) implies it as well
    if (flags & 0x1) {
      skipped.push({ name, why: "the entry is password-protected" });
      continue;
    }
    if (method !== 0 && method !== 8) {
      skipped.push({ name, why: `compression method ${method} is not supported` });
      continue;
    }
    if (uncompressedSize === ZIP64_MARKER || compressedSize === ZIP64_MARKER) {
      skipped.push({ name, why: "the entry needs zip64" });
      continue;
    }
    // Checked before inflating, which is what makes a bomb cost nothing
    if (uncompressedSize > limits.maxEntryBytes) {
      skipped.push({ name, why: `larger than ${mb(limits.maxEntryBytes)}` });
      continue;
    }
    if (total + uncompressedSize > limits.maxTotalBytes) {
      skipped.push({ name, why: `the archive holds more than ${mb(limits.maxTotalBytes)}` });
      continue;
    }
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOCAL_SIGNATURE) {
      skipped.push({ name, why: "its header is missing from the archive" });
      continue;
    }

    // The local header's own name and extra lengths, which may differ from the directory's
    const localNameLen = buf.readUInt16LE(localAt + 26);
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    const from = localAt + 30 + localNameLen + localExtraLen;
    if (from + compressedSize > buf.length) {
      skipped.push({ name, why: "the entry runs past the end of the archive" });
      continue;
    }

    let data: Buffer;
    try {
      data = inflate(buf.subarray(from, from + compressedSize), method);
    } catch (err: any) {
      skipped.push({ name, why: `could not be decompressed (${err?.message ?? err})` });
      continue;
    }
    if (data.length !== uncompressedSize) {
      skipped.push({ name, why: "its size does not match what the archive declares" });
      continue;
    }

    total += data.length;
    files.push({ name, data });
  }

  return { files, skipped };
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
