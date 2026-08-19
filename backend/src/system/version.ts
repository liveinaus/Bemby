import { readFileSync } from "node:fs";
import { join } from "node:path";

// What this build is, and which release line it belongs to.
//
// The version is stamped into the image at build time (see the Dockerfile's BEMBY_VERSION
// arg, filled by the publish workflow). Outside a published image -- a source checkout, a
// locally built image -- there is no stamp, so package.json stands in and the update check
// stays quiet rather than comparing a dev tree against a release.

/**
 * The three lines the publish workflow builds, each with its own image alias. They never
 * compare against each other: a stable install is not told a dev tag is "newer".
 */
export type ReleaseChannel = "latest" | "beta" | "dev";

export type BuildInfo = {
  /** Version of the running build, or "" when this is not a published image. */
  version: string;
  channel: ReleaseChannel;
  /** Whether the version was stamped in at build time; false means the check stays off. */
  stamped: boolean;
};

/** Channel a tag or version belongs to, read the way the publish workflow decides it. */
export function channelOf(version: string): ReleaseChannel {
  const v = version.trim().toLowerCase();
  if (v.startsWith("dev-")) return "dev";
  if (v.includes("-beta")) return "beta";
  return "latest";
}

function packageVersion(): string {
  try {
    // dist/system/version.js at runtime, src/system/version.ts under tsx: both two up
    const pkg = readFileSync(join(__dirname, "..", "..", "package.json"), "utf8");
    return String(JSON.parse(pkg).version ?? "");
  } catch {
    return "";
  }
}

let cached: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  if (cached) return cached;
  const stamp = (process.env.BEMBY_VERSION ?? "").trim();
  const version = stamp || packageVersion();
  const declared = (process.env.BEMBY_CHANNEL ?? "").trim().toLowerCase();
  const channel: ReleaseChannel =
    declared === "beta" || declared === "dev" || declared === "latest"
      ? declared
      : channelOf(version);
  cached = { version, channel, stamped: Boolean(stamp) };
  return cached;
}

/** Test seam: forget what was read from the environment. */
export function resetBuildInfo(): void {
  cached = null;
}

// ── Comparing versions ────────────────────────────────────────────────────────

type Parsed = { core: number[]; pre: string[] };

/**
 * Reads a tag as numbers to compare. Covers the three shapes the workflow produces:
 * `v1.2.3`, `v1.2.3-beta.4` and `dev-v1.2.3-4`, with the leading `dev-` and `v` dropped and
 * whatever follows the first hyphen taken as the prerelease part.
 */
export function parseVersion(tag: string): Parsed | null {
  const text = tag.trim().replace(/^dev-/i, "").replace(/^v/i, "");
  const at = text.indexOf("-");
  const core = (at === -1 ? text : text.slice(0, at)).split(".");
  if (!core.length || core.some((n) => !/^\d+$/.test(n))) return null;
  return {
    core: core.map(Number),
    pre: at === -1 ? [] : text.slice(at + 1).split("."),
  };
}

/**
 * Semver ordering, negative when `a` is the older one. A build with no prerelease part is
 * newer than the same core with one, and identifiers that are numbers compare as numbers so
 * `beta.10` lands after `beta.9`.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  const depth = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < depth; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff) return diff < 0 ? -1 : 1;
  }

  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;

  const parts = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < parts; i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    // A shorter prerelease is the older one: beta.1 precedes beta.1.1
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const bothNumeric = /^\d+$/.test(l) && /^\d+$/.test(r);
    const diff = bothNumeric ? Number(l) - Number(r) : l.localeCompare(r);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Whether `candidate` is a release this build should be told about. */
export function isNewer(current: string, candidate: string): boolean {
  return compareVersions(current, candidate) < 0;
}
