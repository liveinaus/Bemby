import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { SocksClient } from "socks";
import type { BrowserContext, Page } from "playwright-core";
import { cfTuning } from "./cfTuning";
import { applyCfFontEnv } from "./cfFonts";
import { anyCfLicenseKey, cfLicenseUsage, leaseCfLicenseKey } from "./cfLicense";
import { db } from "../db/database";
import { dataDir } from "./paths";
import { cfExitGeo, proxyLabelForUrl, type CfExitGeo } from "../tg/proxyProviders";

// The browser behind the Cloudflare solver: CloakBrowser, a Chromium built with
// source-level fingerprint patches (canvas, WebGL, audio, fonts, WebRTC, TLS,
// navigator.webdriver) and driven through Playwright. Nothing here decides whether a
// challenge passed -- that is cloudflare.ts; this module only produces a page to work with.
//
// The image ships without a browser to stay small. The stealth binary (~200MB) is
// downloaded on demand into the data dir, which is a volume, so it survives a restart and
// an upgrade.

/**
 * Where CloakBrowser caches its Chromium builds: a data-dir subfolder, unless the operator
 * has pointed the library somewhere else. Honouring the override here too keeps what the
 * settings page reports as installed in step with what the library actually downloads.
 */
export function cloakCacheDir(): string {
  return process.env.CLOAKBROWSER_CACHE_DIR || path.join(dataDir(), "cloakbrowser");
}

/** Settings key holding the locale the browser reports, when it is not left to the exit. */
export const CF_BROWSER_LANG_KEY = "cf_browser_lang";

/**
 * The locale the browser should report, when the operator has pinned one.
 *
 * Normally this follows the country the exit comes out in, which is what keeps the browser
 * consistent with its IP. Pinning it is for the case that outweighs that: an app which
 * renders in whatever language the browser asks for, where a step naming a control by its
 * Chinese wording only ever finds it if the app is speaking Chinese.
 */
export function cfBrowserLang(): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CF_BROWSER_LANG_KEY) as
      | { value: string }
      | undefined;
    return row?.value?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Data-dir subfolder holding one browser profile per exit. */
export function cfProfilesRoot(): string {
  return path.join(dataDir(), "cf-profiles");
}

/**
 * CloakBrowser is configured through the environment, so it is set up before any call into
 * the library. Anything the operator has already set is left alone.
 *
 * Auto-update is off: left on, the library downloads a new 200MB build in the background
 * the moment a job launches a browser, onto the user's data volume and over whatever
 * bandwidth the job is using. Settings has a Reinstall button for that instead.
 */
function applyCloakEnv(): void {
  if (!process.env.CLOAKBROWSER_CACHE_DIR) process.env.CLOAKBROWSER_CACHE_DIR = cloakCacheDir();
  if (!process.env.CLOAKBROWSER_AUTO_UPDATE) process.env.CLOAKBROWSER_AUTO_UPDATE = "false";
}

// The library is ESM-only and the backend compiles to CommonJS, so a plain import would be
// downlevelled to require() and fail. This keeps it a real dynamic import.
type CloakModule = typeof import("cloakbrowser");
const importEsm = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;
let cloakModule: Promise<CloakModule> | undefined;
function cloak(): Promise<CloakModule> {
  applyCloakEnv();
  cloakModule ??= importEsm("cloakbrowser") as Promise<CloakModule>;
  return cloakModule;
}

/**
 * Asks CloakBrowser's server what a licence key is worth. A key that was mistyped or has
 * lapsed otherwise shows up only as jobs quietly running the older free build.
 */
export async function checkCfLicenseKey(key: string): Promise<{
  valid: boolean;
  plan?: string;
  expires?: string;
  error?: string;
}> {
  try {
    const { validateLicense } = await cloak();
    const info = await validateLicense(key);
    if (!info) return { valid: false, error: "CloakBrowser could not be reached" };
    return { valid: info.valid, plan: info.plan, expires: info.expires ?? undefined };
  } catch (err: any) {
    return { valid: false, error: err?.message ?? String(err) };
  }
}

/** Segments of a CloakBrowser version ("146.0.7680.177.5"), for comparing installs. */
function versionParts(v: string): number[] {
  return v.split(".").map((n) => Number(n) || 0);
}

function versionNewer(a: string, b: string): boolean {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** A build a licence key unlocks, or the one that needs none. */
type BuildTier = "keyed" | "free";

type CachedBuild = { version: string; tier: BuildTier; exe: string };

/**
 * The stealth Chromium builds in the cache dir. Read off the filesystem rather than asked
 * of the library, so the settings page can report what is installed without an async call
 * -- and without the library reaching out to check for an update.
 *
 * A keyed build unpacks into a `-pro` directory whether the key is free or paid.
 */
function cachedBuilds(): CachedBuild[] {
  // The layout CloakBrowser unpacks into. Linux is what the image runs; the others are
  // for a developer machine.
  const exeName =
    process.platform === "darwin"
      ? "Chromium.app/Contents/MacOS/Chromium"
      : process.platform === "win32"
        ? "chrome.exe"
        : "chrome";

  const out: CachedBuild[] = [];
  try {
    for (const name of readdirSync(cloakCacheDir())) {
      const match = /^chromium-([\d.]+)(-pro)?$/.exec(name);
      if (!match) continue;
      const exe = path.join(cloakCacheDir(), name, exeName);
      // A directory with no executable is what a download that died halfway leaves behind
      if (!existsSync(exe)) continue;
      out.push({ version: match[1], tier: match[2] ? "keyed" : "free", exe });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => (versionNewer(a.version, b.version) ? -1 : 1));
}

/** The build that would launch for `tier`, falling back to whatever is installed. */
function resolvedBuild(tier?: BuildTier): CachedBuild | undefined {
  const builds = cachedBuilds();
  if (!tier) return builds[0];
  const exact = builds.find((b) => b.tier === tier);
  if (exact) return exact;
  // Standing in for the tier asked for is only safe one way round. A free build handed a
  // key ignores it and runs; the keyed build asked to run without one refuses and quits
  // during startup, which reaches the operator as a browser that closed itself with no
  // stated reason and a page of Chromium log. So "free" is never served the keyed build.
  return tier === "keyed" ? builds.find((b) => b.tier === "free") : undefined;
}

/**
 * A CloakBrowser binary the operator pinned themselves, which is how an older build is
 * rolled back to. The library reads this variable directly as well, so honouring it here
 * only keeps the settings page in step with what will launch.
 */
function pinnedBinary(): string | undefined {
  const pin = process.env.CLOAKBROWSER_BINARY_PATH;
  return pin && existsSync(pin) ? pin : undefined;
}

// The previous solver launched whatever PUPPETEER_EXECUTABLE_PATH named, and installs that
// were set up then still carry it. It is deliberately not honoured any more: a stock
// Chromium has none of the fingerprint patches, so a job pointed at one is not solving
// anything -- it just looks like it is.
let warnedLegacyPin = false;
function warnLegacyPin(): void {
  if (warnedLegacyPin || !process.env.PUPPETEER_EXECUTABLE_PATH) return;
  warnedLegacyPin = true;
  console.warn(
    `[cfBrowser] ignoring PUPPETEER_EXECUTABLE_PATH (${process.env.PUPPETEER_EXECUTABLE_PATH}): ` +
      "the solver only launches CloakBrowser builds. Remove it from your .env, and delete " +
      "the browser it points at to reclaim the space.",
  );
}

/**
 * The browser that will launch: the operator's pin, else the downloaded stealth build of
 * the tier matching whether a licence key is in hand -- a keyed build declines to run
 * without one.
 */
export function chromiumExecutable(tier?: BuildTier): string | undefined {
  warnLegacyPin();
  return pinnedBinary() ?? resolvedBuild(tier)?.exe;
}

export function isChromiumInstalled(): boolean {
  return !!chromiumExecutable();
}

/** Tier of the build that is installed, for the settings view. */
export function installedBuildTier(): BuildTier | undefined {
  if (pinnedBinary()) return undefined;
  return resolvedBuild()?.tier;
}

/**
 * A licence key is configured but the build it unlocks has not been downloaded, so jobs
 * are still launching the older free one. Downloading is deliberate rather than automatic
 * (see the launch pin), so this is what tells the operator there is something to fetch.
 */
export function keyedBuildPending(): boolean {
  if (pinnedBinary()) return false;
  const hasKey = !!process.env.CLOAKBROWSER_LICENSE_KEY?.trim() || cfLicenseUsage().total > 0;
  return hasKey && !cachedBuilds().some((build) => build.tier === "keyed");
}

/**
 * Version of the browser that will launch, e.g. "CloakBrowser 150.0.7871.114.4".
 *
 * Read from the directory the build was unpacked into rather than by running it: the
 * keyed build refuses to start without its licence key, and the key lives in the database
 * rather than this process's environment, so asking the binary reports nothing at all --
 * which is how the settings page ended up naming the build it had replaced.
 */
export function chromiumVersion(): string | undefined {
  const build = resolvedBuild();
  if (build && !pinnedBinary()) return `CloakBrowser ${build.version}`;

  // A pinned binary has no version in its path, so it has to be asked
  const exe = pinnedBinary();
  if (!exe) return undefined;
  try {
    const out = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 15_000 });
    return `${out.stdout ?? ""}`.trim().split("\n")[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Path of the browser that will launch, so the settings page can name it exactly. */
export function chromiumPath(): string | undefined {
  return chromiumExecutable();
}

/**
 * Every downloaded build, for the settings page. Both tiers can be on disk at once -- the
 * keyed one for normal runs, the unlicensed one for when no seat is free -- and a job may
 * use either, so reporting only the preferred one hides half of what is installed.
 */
export function installedCfBuilds(): Array<{
  tier: BuildTier;
  version: string;
  path: string;
  /** The build a run takes when a licence seat is available, i.e. the usual one. */
  preferred: boolean;
}> {
  const builds = cachedBuilds();
  const preferred = resolvedBuild()?.exe;
  return builds.map((b) => ({
    tier: b.tier,
    version: b.version,
    path: b.exe,
    preferred: b.exe === preferred,
  }));
}

/**
 * Downloads the stealth Chromium into the data dir. Long-running (~200MB) but needs no
 * root: it writes to the data volume as the app's own user.
 *
 * `force` clears the cache first, which is how the browser is moved to a newer build.
 */
/**
 * Downloads a build into the data dir.
 *
 * `tier` names which one: "keyed" (or unset) follows the configured licence keys, "free"
 * fetches the unlicensed build regardless of them. Having the free build alongside the
 * keyed one is what lets a launch that cannot take a licence seat still run -- the keyed
 * binary refuses to start without one, so with only that on disk there is no fallback.
 */
export async function installCfChromium(
  force = false,
  tier?: BuildTier,
): Promise<{ ok: boolean; output: string }> {
  applyCloakEnv();
  const lines: string[] = [];
  const cacheDir = process.env.CLOAKBROWSER_CACHE_DIR || cloakCacheDir();
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (err: any) {
    return { ok: false, output: `Cannot write to ${cacheDir}: ${err?.message ?? err}` };
  }
  // Checked before the download rather than during it: the library streams straight to a
  // file, and a write that fails part-way surfaces as an unhandled stream error, which
  // takes the whole backend down rather than failing this request.
  try {
    accessSync(cacheDir, fsConstants.W_OK);
  } catch {
    return {
      ok: false,
      output:
        `Cannot write to ${cacheDir}. The browser is downloaded into the data dir, so that ` +
        "directory has to be writable by the user this app runs as -- check its ownership.",
    };
  }

  // Any configured key will do here: which build is downloaded is the same question for
  // all of them, and this is not a browser session, so it takes no seat. Asking for the
  // free build deliberately ignores them -- that is the point of the request.
  const licenseKey = tier === "free" ? undefined : anyCfLicenseKey();
  try {
    const { ensureBinary, binaryInfo } = await cloak();
    // Only the build being replaced is cleared, not the whole cache: the other tier is
    // what an overflow launch falls back to, and re-downloading it is another 200MB.
    if (force) {
      const dropped = removeBuild(licenseKey ? "keyed" : "free");
      lines.push(dropped ? `Cleared ${dropped}` : "Nothing cached to clear");
    }
    const exe = await ensureBinary(licenseKey);
    const info = binaryInfo();
    lines.push(`CloakBrowser ${info.version} (${info.tier} build) at ${exe}`);
    if (!licenseKey && tier !== "free") {
      lines.push(
        "No licence key configured, so this is the older free build. Add a free key in " +
          "Settings for the current one, which passes more challenges.",
      );
    }
    if (tier === "free") {
      lines.push(
        "This is the unlicensed build, kept alongside the keyed one. A run that cannot " +
          "take a licence seat falls back to it instead of failing.",
      );
    }
  } catch (err: any) {
    return { ok: false, output: `${lines.join("\n")}\n${err?.message ?? err}`.trim() };
  }

  if (!isChromiumInstalled()) {
    return { ok: false, output: `${lines.join("\n")}\nThe download finished but no browser is in ${cloakCacheDir()}` };
  }
  const version = chromiumVersion();
  if (version) lines.push(version);
  const dropped = pruneOldBuilds();
  if (dropped) lines.push(dropped);
  const reclaimed = pruneLegacyBrowsers();
  if (reclaimed) lines.push(reclaimed);
  return { ok: true, output: lines.join("\n") };
}

/** Drops the cached build of one tier, so the next install fetches it again. */
function removeBuild(tier: BuildTier): string | undefined {
  const build = cachedBuilds().find((b) => b.tier === tier);
  if (!build) return undefined;
  const dir = path.dirname(build.exe);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err: any) {
    console.warn(`[cfBrowser] could not remove ${dir}: ${err?.message ?? err}`);
    return undefined;
  }
  return path.basename(dir);
}

/**
 * Keeps the newest build of each tier and drops the rest. An update leaves the build it
 * replaced behind, and each is several hundred MB unpacked, which on a self-hosted volume
 * adds up fast. Both tiers are kept because which one launches depends on whether a
 * licence key is free at the time.
 */
/**
 * Deletes every browser profile: the cookies, cache and site data each exit has built up.
 *
 * Worth having as a button because a profile is the one piece of state a run carries over
 * from the last one, so it is what to clear when a browser has started failing for no
 * reason that changed elsewhere -- a half-written profile from a browser that was killed
 * can keep Chromium from starting at all. Nothing identifying is lost: the fingerprint
 * comes from a seed derived from the exit, not from the profile, so each exit comes back
 * as the same machine.
 */
export function clearCfProfiles(): { removed: number; error?: string } {
  if (liveBrowsers.size > 0) {
    return {
      removed: 0,
      error:
        `${liveBrowsers.size} browser(s) are still running and are using their profiles. ` +
        "Stop the browsers first, then try again.",
    };
  }
  let names: string[];
  try {
    names = readdirSync(cfProfilesRoot());
  } catch (err: any) {
    // A missing directory is nothing to clear rather than a failure
    if (err?.code === "ENOENT") return { removed: 0 };
    return { removed: 0, error: `Could not read ${cfProfilesRoot()}: ${err?.message ?? err}` };
  }

  // Each profile stands alone, so one that cannot be removed must not hold up the rest --
  // clearing the others is the point of the exercise.
  let removed = 0;
  const failed: string[] = [];
  let firstError = "";
  for (const name of names) {
    try {
      rmSync(path.join(cfProfilesRoot(), name), { recursive: true, force: true });
      removed++;
    } catch (err: any) {
      failed.push(name);
      firstError ||= err?.message ?? String(err);
    }
  }
  profilesInUse.clear();
  if (failed.length) {
    return {
      removed,
      error: `${removed} cleared, ${failed.length} could not be removed (${firstError})`,
    };
  }
  return { removed };
}

/** How many browser profiles are on disk, for the settings page. */
export function cfProfileCount(): number {
  try {
    return readdirSync(cfProfilesRoot()).length;
  } catch {
    return 0;
  }
}

// ── Managing profiles by hand ────────────────────────────────────────────────
//
// A run makes its own profiles and pruneProfiles trims them, which is right for the pooled
// per-exit ones: they are cheap to rebuild. A profile someone created or imported carries a
// session that was set up deliberately -- signed in by hand through the VNC browser, or
// brought over from another instance -- so it is marked on creation and left out of that
// housekeeping. Otherwise the twelfth new exit would quietly evict it.

/** Marks a profile as made or imported by hand, which keeps LRU trimming off it. */
const MANAGED_MARKER = ".bemby-managed";

/**
 * The name a profile's device was seeded from, written only once it stops being the
 * directory's own name -- which is what a rename does. Without it a renamed profile keeps its
 * cookies but comes back on a different machine, and a session returning to a device that has
 * changed is exactly what a site watches for.
 */
const SEED_MARKER = ".bemby-seed";

/** What this profile's device is derived from: the name it was first known by. */
function seedKeyFor(dir: string, key: string): string {
  try {
    const stored = readFileSync(path.join(dir, SEED_MARKER), "utf8").trim();
    if (stored) return stored;
  } catch {
    /* never renamed, so the directory name is the seed */
  }
  return key;
}

/** What a profile directory may be called: the same alphabet cfProfileKey produces. */
export const CF_PROFILE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export type CfProfileInfo = {
  name: string;
  sizeBytes: number;
  /** Epoch ms of the last run that opened it, or null when no run ever has. */
  lastUsedAt: number | null;
  /** A browser has it open right now, so it cannot be deleted or overwritten. */
  inUse: boolean;
  /** Created or imported by hand, and therefore exempt from LRU trimming. */
  managed: boolean;
};

/** Path of a named profile, or undefined when the name is not one we would ever write. */
export function cfProfileDir(name: string): string | undefined {
  if (!CF_PROFILE_NAME_RE.test(name)) return undefined;
  return path.join(cfProfilesRoot(), name);
}

/** Is a browser holding this profile open? Both scheduled runs and VNC sessions claim it. */
export function cfProfileInUse(name: string): boolean {
  return profilesInUse.has(name);
}

export function markCfProfileManaged(dir: string): void {
  try {
    writeFileSync(path.join(dir, MANAGED_MARKER), "");
  } catch {
    /* the profile still works unmanaged; it is only exempt from trimming */
  }
}

const isManaged = (dir: string): boolean => existsSync(path.join(dir, MANAGED_MARKER));

/** Bytes on disk, walked iteratively -- a profile is a deep tree, not a flat directory. */
function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const next = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(next, { withFileTypes: true });
    } catch {
      continue; // a directory that vanished mid-walk contributes nothing
    }
    for (const entry of entries) {
      const full = path.join(next, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* same */
        }
      }
    }
  }
  return total;
}

/** Every profile on disk, for the settings page. Throwaways are not profiles. */
export function listCfProfiles(): CfProfileInfo[] {
  let names: string[];
  try {
    names = readdirSync(cfProfilesRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("tmp-"))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const dir = path.join(cfProfilesRoot(), name);
      let usedAt: number | null = null;
      try {
        usedAt = statSync(path.join(dir, USED_MARKER)).mtimeMs;
      } catch {
        usedAt = null;
      }
      return {
        name,
        sizeBytes: dirSize(dir),
        lastUsedAt: usedAt,
        inUse: profilesInUse.has(name),
        managed: isManaged(dir),
      };
    })
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name));
}

/**
 * Creates an empty profile under a name a job's profile field (or a VNC session) can then
 * target. The browser fills it in on first launch; until then it is an empty directory that
 * simply reserves the name.
 */
export function createCfProfile(name: string): { ok: boolean; error?: string } {
  const trimmed = name.trim();
  if (!CF_PROFILE_NAME_RE.test(trimmed))
    return {
      ok: false,
      error: "Name must be 1-64 characters of letters, digits, hyphen or underscore",
    };
  const dir = path.join(cfProfilesRoot(), trimmed);
  if (existsSync(dir)) return { ok: false, error: `Profile "${trimmed}" already exists` };
  try {
    mkdirSync(dir, { recursive: true });
    markCfProfileManaged(dir);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: `Could not create ${dir}: ${err?.message ?? err}` };
  }
}

/**
 * Renames a profile, session and device intact.
 *
 * The name is what a job's profile field targets, so this is how a jar built up under a
 * pooled name (`direct`, an exit hash) is moved somewhere a job can ask for it by name --
 * and how the pooled name is freed for a fresh start. The device seed is pinned to the old
 * name on the way, since it is derived from the name and the cookies were issued to the
 * machine it produced. The result is marked managed: a name chosen by hand is not the LRU's
 * to evict.
 *
 * Refused while a browser has it open. A rename under a running job would take the directory
 * out from under it, and Chromium does not survive that.
 */
export function renameCfProfile(from: string, to: string): { ok: boolean; error?: string } {
  const target = to.trim();
  const source = cfProfileDir(from);
  if (!source) return { ok: false, error: `"${from}" is not a valid profile name` };
  if (!CF_PROFILE_NAME_RE.test(target))
    return {
      ok: false,
      error: "Name must be 1-64 characters of letters, digits, hyphen or underscore",
    };
  if (target === from) return { ok: true };
  if (!existsSync(source)) return { ok: false, error: `No profile called "${from}"` };
  if (profilesInUse.has(from))
    return { ok: false, error: `A browser has "${from}" open; close it and try again` };
  const dest = path.join(cfProfilesRoot(), target);
  if (existsSync(dest)) return { ok: false, error: `Profile "${target}" already exists` };

  try {
    // Written before the move, while the old name is still what the device came from
    writeFileSync(path.join(source, SEED_MARKER), seedKeyFor(source, from));
  } catch {
    /* the rename is still worth doing; the profile comes back on a new device */
  }
  try {
    renameSync(source, dest);
  } catch (err: any) {
    return { ok: false, error: `Could not rename: ${err?.message ?? err}` };
  }
  markCfProfileManaged(dest);
  return { ok: true };
}

/**
 * Deletes the named profiles. One that a browser has open is refused rather than pulled out
 * from under it, and one failure does not stop the rest -- same reasoning as clearCfProfiles.
 */
export function deleteCfProfiles(names: string[]): {
  removed: string[];
  refused: Array<{ name: string; reason: string }>;
} {
  const removed: string[] = [];
  const refused: Array<{ name: string; reason: string }> = [];
  for (const name of names) {
    const dir = cfProfileDir(name);
    if (!dir) {
      refused.push({ name, reason: "Not a valid profile name" });
      continue;
    }
    if (profilesInUse.has(name)) {
      refused.push({ name, reason: "A browser has this profile open" });
      continue;
    }
    if (!existsSync(dir)) {
      refused.push({ name, reason: "No such profile" });
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch (err: any) {
      refused.push({ name, reason: err?.message ?? String(err) });
    }
  }
  return { removed, refused };
}

/**
 * Deletes every downloaded build, freeing the ~200MB each takes in the data dir. The
 * solver has nothing to launch afterwards, so this is the counterpart of the download
 * button rather than something a job ever does.
 */
export function removeAllCfBuilds(): { removed: string[]; error?: string } {
  if (liveBrowsers.size > 0) {
    return {
      removed: [],
      error:
        `${liveBrowsers.size} browser(s) are still running. Wait for those jobs to finish, ` +
        "or stop the browsers first, then try again.",
    };
  }
  const removed: string[] = [];
  for (const build of cachedBuilds()) {
    const dir = path.dirname(build.exe);
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(path.basename(dir));
    } catch (err: any) {
      return { removed, error: `Could not remove ${dir}: ${err?.message ?? err}` };
    }
  }
  return { removed };
}

function pruneOldBuilds(): string | undefined {
  const keep = new Set(
    (["keyed", "free"] as BuildTier[])
      .map((tier) => cachedBuilds().find((b) => b.tier === tier))
      .filter((b): b is CachedBuild => !!b)
      .map((b) => path.dirname(b.exe)),
  );
  if (!keep.size) return undefined;
  const dropped: string[] = [];
  try {
    for (const name of readdirSync(cloakCacheDir())) {
      if (!/^chromium-/.test(name)) continue;
      const full = path.join(cloakCacheDir(), name);
      if (keep.has(full)) continue;
      rmSync(full, { recursive: true, force: true });
      dropped.push(name);
    }
  } catch {
    /* housekeeping only */
  }
  return dropped.length ? `Removed ${dropped.length} superseded build(s): ${dropped.join(", ")}` : undefined;
}

/**
 * Removes the browsers earlier versions installed: the Playwright download and the
 * Alpine-era apk root. Both are caches this app wrote and no longer launches, and between
 * them they are most of a gigabyte on the user's volume.
 */
function pruneLegacyBrowsers(): string | undefined {
  const stale = ["pw-browsers", ".pw-browsers", "cf-chromium"]
    .map((name) => path.join(dataDir(), name))
    .filter((dir) => existsSync(dir));
  if (!stale.length) return undefined;
  for (const dir of stale) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err: any) {
      console.warn(`[cfBrowser] could not remove ${dir}: ${err?.message ?? err}`);
    }
  }
  return `Removed the browser left by the previous solver (${stale.map((d) => path.basename(d)).join(", ")})`;
}

// ── Virtual display ──────────────────────────────────────────────────────────
//
// The browser runs headed: a challenge is scored on far more than the headless flag, and
// the pass rate headed is not close. On a server there is no display, so one Xvfb is
// started for the process and every browser shares it.

let displayPromise: Promise<string | undefined> | undefined;

function displaySocket(display: string): string {
  return `/tmp/.X11-unix/X${display.replace(/^:/, "").split(".")[0]}`;
}

/** The desktop the browser opens on when nothing asks for more room. */
const DEFAULT_SCREEN = { width: 1920, height: 1080 };

/**
 * The window geometry the settings ask for, or undefined for Chromium's own choice.
 *
 * Both numbers are needed: half a size is not a window. Anything implausibly small is
 * ignored rather than clamped -- a 100px window renders a mobile layout nothing on the page
 * expects, and silently correcting it would hide the typo.
 */
function configuredWindow(): { width: number; height: number } | undefined {
  const { windowWidth: width, windowHeight: height } = cfTuning();
  if (width < 400 || height < 400) return undefined;
  return { width, height };
}

/** The screen this process started, so a window asking for more room can be reported. */
let startedScreen: { width: number; height: number } | undefined;

/**
 * One X server serves the whole process and it is sized when the first browser launches, so
 * a size raised afterwards has nothing to grow into and the window is clipped to the screen.
 * Silently rendering shorter than asked is the confusing outcome; saying so is not.
 */
function warnIfWindowExceedsScreen(win?: { width: number; height: number }): void {
  if (!win || !startedScreen) return;
  if (win.width <= startedScreen.width && win.height + 140 <= startedScreen.height) return;
  console.warn(
    `[cfBrowser] the window size in settings (${win.width}x${win.height}) does not fit the ` +
      `virtual screen already running (${startedScreen.width}x${startedScreen.height}), so the ` +
      "page will be clipped to it. Restart the app to start a screen that holds it.",
  );
}

/**
 * Starts one X server on a free display number. The socket appearing is what proves it
 * came up: a process that died is still an unreaped child that looks alive.
 */
async function startXvfb(): Promise<{ display: string; proc: ChildProcess } | undefined> {
  // Room for one display per concurrent run, not just the shared one
  for (let n = 99; n < 200; n++) {
    const display = `:${n}`;
    if (existsSync(displaySocket(display))) continue;

    // Sized to the desktop the stealth build reports to a page, so the window it opens
    // sits inside a screen of a plausible size rather than filling a small one. A window
    // configured taller or wider than that gets a screen grown to hold it: one that does not
    // fit is clipped, and the page then renders shorter than the size that was asked for.
    const want = configuredWindow();
    const width = Math.max(DEFAULT_SCREEN.width, want?.width ?? 0);
    // Room for the window frame and the browser's own chrome above the page
    const height = Math.max(DEFAULT_SCREEN.height, (want?.height ?? 0) + 140);
    const proc = spawn(
      "Xvfb",
      [display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"],
      { stdio: "ignore" },
    );
    // Not on the path at all, as opposed to started and then exited
    let missing = false;
    const died = new Promise<false>((resolve) => {
      proc.once("error", () => {
        missing = true;
        resolve(false);
      });
      proc.once("exit", () => resolve(false));
    });
    const up = (async () => {
      for (let i = 0; i < 40; i++) {
        if (existsSync(displaySocket(display))) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    })();

    if (await Promise.race([died, up])) {
      // Killed with the app so a restart does not leave X servers behind
      process.once("exit", () => proc.kill());
      startedScreen = { width, height };
      console.log(`[cfBrowser] started Xvfb on ${display} at ${width}x${height}`);
      return { display, proc };
    }
    proc.kill();
    if (missing) break; // trying other display numbers cannot help
  }
  return undefined;
}

/**
 * A display for the headed browser: the one already in the environment, else an Xvfb of
 * our own. Undefined when there is none to be had, which leaves the browser headless --
 * it still runs, it just passes fewer challenges.
 */
async function ensureDisplay(): Promise<string | undefined> {
  displayPromise ??= (async () => {
    const existing = process.env.DISPLAY;
    if (existing && existsSync(displaySocket(existing))) return existing;
    const started = await startXvfb();
    if (!started) {
      console.warn(
        "[cfBrowser] no X display and Xvfb could not be started; the browser will run " +
          "headless, which passes fewer challenges. Install xvfb on the host.",
      );
      return undefined;
    }
    process.env.DISPLAY = started.display;
    return started.display;
  })();
  return displayPromise;
}

/**
 * A display nothing else is drawing on, for a browser someone is going to watch: the shared
 * one carries every job's browser at once, and a viewer pointed at that would show them all.
 * The caller owns it and must end it -- `close` takes the X server down with it.
 */
export async function startPrivateDisplay(): Promise<
  { display: string; close: () => void } | undefined
> {
  const started = await startXvfb();
  if (!started) return undefined;
  return { display: started.display, close: () => started.proc.kill() };
}

// ── Profiles ─────────────────────────────────────────────────────────────────
//
// One profile per exit, so cookies -- above all the cf_clearance a solved challenge issues
// -- outlive the browser. Without one every attempt arrives as a first-time visitor, which
// is exactly what a managed challenge is looking for.

/**
 * Stable id for an exit, used to name its profile and remember its geography. The proxy
 * URL is hashed rather than stored: it carries credentials, and this ends up on disk.
 */
function exitKey(proxyUrl?: string): string {
  return proxyUrl ? createHash("sha1").update(proxyUrl).digest("hex").slice(0, 12) : "direct";
}

/** The setting holding the profile name every browser action falls back to. */
export const CF_PROFILE_ID_KEY = "cf_profile_id";

/** The profile name a browser action falls back to when it names none of its own. */
export function configuredProfileId(): string {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CF_PROFILE_ID_KEY) as
      | { value: string }
      | undefined;
    return row?.value?.trim() || CF_PROFILE_ID_DEFAULT;
  } catch {
    return CF_PROFILE_ID_DEFAULT;
  }
}

/** What a profile name is when nothing has been configured: one per exit, pooled. */
export const CF_PROFILE_ID_DEFAULT = "{ip}";

/**
 * What a name resolves to when it asks for no profile at all. Deliberately unspellable in
 * the alphabet cfProfileKey produces, so it can never collide with a profile on disk;
 * `claimProfile` hands out a throwaway directory for it instead of a kept one.
 */
export const CF_NO_PROFILE_KEY = "(none)";

/** The token asking for that: `{noProfile}`, however it is cased, spaced or hyphenated. */
const NO_PROFILE_RE = /\{\s*no[-_\s]?profile\s*\}/i;

/**
 * The same asked for without the braces -- `noProfile`, `no-profile`, `no profile` -- when
 * that is the whole of the name.
 *
 * Written like this it used to become a profile directory called `noProfile`, kept and shared
 * by every run that spelled it the same way: the opposite of what was asked for, and silently,
 * since a persistent profile hands the site back the same cookies and the same device every
 * time. Only the whole field counts, so a name that merely contains the words
 * (`{ip}-noprofile-test`) is still taken as the name it looks like.
 */
const BARE_NO_PROFILE_RE = /^\s*no[-_\s]?profile\s*$/i;

/** What a profile name may be built from, beyond `{ip}` which comes from the exit. */
export type CfProfileVars = {
  /** The job being run, for a profile that belongs to it alone. */
  jobId?: number;
  /** The template it came from, for one profile shared by every job built on it. */
  templateId?: number;
  /** The account it runs as, for one profile per Telegram account across its jobs. */
  tgId?: number | string;
};

/** The names a profile may be built from, and where each gets its value. */
const PROFILE_VAR_NAMES = ["ip", "jobId", "templateId", "tgId", "accountId"] as const;

/**
 * Names the profile directory, and with it the device seed.
 *
 * `template` decides who shares cookies with whom, which is the whole point of it. `{ip}` --
 * the default -- is one profile per exit, so everything going out through it pools a single
 * `cf_clearance`. `{ip}-{jobId}` gives a job its own, which is what anything that logs in
 * wants: two accounts sharing a profile overwrite each other's session, and a site that
 * rations logins will not hand out another. `{tgId}` follows the account across its jobs,
 * `{templateId}` groups everything built on one template, and free text is taken as written,
 * so `user1-{ip}` is a name too.
 *
 * A name that resolves to nothing -- `{jobId}` outside a job, say -- falls back to the exit,
 * which is the shared profile and never the wrong one.
 *
 * `{noProfile}` is the opposite of all this: nothing is kept, so every run arrives as a
 * first-time visitor on a device of its own. That is what a Mini App wants when the same
 * exit runs several accounts -- an app that stores its own session in the profile shows
 * whichever account signed in first, whatever init data Telegram signs afterwards.
 */
export function cfProfileKey(
  proxyUrl?: string,
  template?: string,
  vars: CfProfileVars = {},
): string {
  const exit = exitKey(proxyUrl);
  const values: Record<(typeof PROFILE_VAR_NAMES)[number], string> = {
    ip: exit,
    jobId: vars.jobId ? String(vars.jobId) : "",
    templateId: vars.templateId ? String(vars.templateId) : "",
    // Two spellings of one thing: `{tgId}` is what it is called in the interface, and
    // `{accountId}` is what it actually is -- the account the job runs as
    tgId: vars.tgId ? String(vars.tgId) : "",
    accountId: vars.tgId ? String(vars.tgId) : "",
  };

  const wanted = template?.trim() || CF_PROFILE_ID_DEFAULT;
  // Asked for nothing kept: the token wins over the rest of the name, since a name that
  // half-persists is no answer either way. Taken with or without its braces -- a field
  // holding just `noProfile` means what it says, and reading it as a directory name was
  // worse than useless: it kept one profile, shared, for every run that spelled it so.
  if (NO_PROFILE_RE.test(wanted) || BARE_NO_PROFILE_RE.test(wanted)) return CF_NO_PROFILE_KEY;

  const filled = wanted.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const known = PROFILE_VAR_NAMES.find((v) => v.toLowerCase() === name.toLowerCase());
    // An unknown name is left as written and then cleaned off, rather than silently
    // becoming part of every profile's name
    return known ? values[known] : whole;
  });

  // Whatever it was built from, it ends up as a directory name
  const safe = filled
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return safe || exit;
}

/**
 * The device fingerprint seed for a profile. CloakBrowser picks a random one per launch,
 * which would hand the same site a different machine every run -- while the profile hands
 * it the same cookies. Derived from the profile's key instead, so the cookies and the device
 * they were issued to stay together for as long as the profile does.
 */
function fingerprintSeed(key: string): number {
  const digest = createHash("sha1").update(`bemby-fingerprint:${key}`).digest();
  return 10_000 + (digest.readUInt32BE(0) % 90_000);
}

// One Chromium at a time per profile: two sharing a user-data-dir corrupt it, and jobs can
// run concurrently. The loser of the race gets a throwaway profile instead.
const profilesInUse = new Set<string>();

// Chromium writes inside Default/, which leaves the profile's own mtime at creation time,
// so last use is recorded here instead.
const USED_MARKER = ".bemby-last-used";

function lastUsedAt(dir: string): number {
  try {
    return statSync(path.join(dir, USED_MARKER)).mtimeMs;
  } catch {
    try {
      return statSync(dir).mtimeMs;
    } catch {
      return 0;
    }
  }
}

/**
 * Drops the least recently used profiles, keeping the newest maxProfiles of them. A profile
 * created or imported by hand is left alone however old it is: it holds a session someone set
 * up on purpose, which is not housekeeping's to throw away.
 */
function pruneProfiles(root: string): void {
  const tune = cfTuning();
  try {
    const dirs = readdirSync(root)
      .filter(
        (name) =>
          !profilesInUse.has(name) &&
          !name.startsWith("tmp-") &&
          !existsSync(path.join(root, name, MANAGED_MARKER)),
      )
      .map((name) => ({ full: path.join(root, name), usedAt: lastUsedAt(path.join(root, name)) }))
      .sort((a, b) => b.usedAt - a.usedAt);
    for (const stale of dirs.slice(tune.maxProfiles)) {
      rmSync(stale.full, { recursive: true, force: true });
    }
  } catch {
    /* housekeeping only */
  }
}

/**
 * A profile's cookies, kept alongside it between runs.
 *
 * Chromium's own store cannot be relied on for this. A cookie with no expiry -- a session
 * cookie, which is how a great many sites sign you in -- is dropped the moment the browser
 * closes; a desktop browser only seems to keep you signed in because "continue where you
 * left off" puts them back. And even the persistent ones are written through SQLite, which
 * leaves them in a journal that a browser killed on the way out never commits, so a profile
 * can come back with an empty cookie table.
 *
 * So the jar is written out in full when the browser closes and put back when it opens.
 * Kept inside the profile, so it travels with it and is thrown away with it, and stamped so
 * an ancient session is not replayed at a site that forgot it long ago.
 */
const COOKIE_FILE = "bemby-cookies.json";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

type StoredCookies = { savedAt: number; cookies: unknown[] };

async function saveCookies(context: BrowserContext, dir: string): Promise<number> {
  try {
    const cookies = await context.cookies();
    const file = path.join(dir, COOKIE_FILE);
    if (!cookies.length) {
      rmSync(file, { force: true });
      return 0;
    }
    writeFileSync(file, JSON.stringify({ savedAt: Date.now(), cookies }));
    return cookies.length;
  } catch {
    // A browser already gone has nothing to hand over; whatever was saved last run stands
    return 0;
  }
}

async function restoreCookies(context: BrowserContext, dir: string): Promise<number> {
  const file = path.join(dir, COOKIE_FILE);
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as StoredCookies;
    if (!stored?.cookies?.length) return 0;
    if (Date.now() - (stored.savedAt ?? 0) > COOKIE_MAX_AGE_MS) {
      rmSync(file, { force: true });
      return 0;
    }
    // One that has since expired is not worth handing back, and Chromium would refuse it
    const now = Date.now() / 1000;
    type Stored = Parameters<BrowserContext["addCookies"]>[0][number];
    const live = (stored.cookies as Stored[]).filter(
      (c) => !c.expires || c.expires <= 0 || c.expires > now,
    );
    if (!live.length) return 0;
    await context.addCookies(live);
    return live.length;
  } catch {
    return 0;
  }
}

type ClaimedProfile = {
  dir: string;
  release: () => void;
  /** What the device fingerprint is derived from -- see `fingerprintSeed`. */
  seedKey: string;
};

/**
 * The profile directory for this exit. When it is already open elsewhere -- or cannot be
 * created -- a throwaway one is used instead, which is thrown away with the browser.
 */
function claimProfile(key: string): ClaimedProfile {
  const throwaway = (seedKey: string): ClaimedProfile => {
    const root = existsSync(cfProfilesRoot()) ? cfProfilesRoot() : os.tmpdir();
    const dir = mkdtempSync(path.join(root, "tmp-"));
    // A fallback keeps the profile's device so the cookies it may still restore match it;
    // one asked for by name keeps nothing, so it gets a device of its own from the unique
    // directory name -- otherwise every no-profile run in the fleet is the same machine
    return {
      dir,
      release: () => rmSync(dir, { recursive: true, force: true }),
      seedKey: seedKey || dir,
    };
  };

  if (key === CF_NO_PROFILE_KEY) return throwaway("");
  if (profilesInUse.has(key)) return throwaway(key);
  const dir = path.join(cfProfilesRoot(), key);
  try {
    mkdirSync(dir, { recursive: true });
    // A browser that was killed leaves these behind, and Chromium then refuses the profile
    // as "already in use"
    for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      rmSync(path.join(dir, lock), { force: true });
    }
    writeFileSync(path.join(dir, USED_MARKER), "");
    profilesInUse.add(key);
    pruneProfiles(cfProfilesRoot());
    // The name it was first known by, which a rename leaves behind: the cookies were issued
    // to the device that name produced, and they have to come back on it
    return { dir, release: () => profilesInUse.delete(key), seedKey: seedKeyFor(dir, key) };
  } catch (err: any) {
    console.warn(`[cfBrowser] no persistent profile (${err?.message ?? err})`);
    return throwaway(key);
  }
}

// ── Proxies ──────────────────────────────────────────────────────────────────

type SocksBridge = { port: number; close: () => void };

/**
 * A loopback HTTP proxy in front of an authenticated SOCKS5 exit, for the browser's
 * lifetime. Chromium's own SOCKS support is the one part of the proxy chain that varies by
 * build, and Bemby's proxies are almost all socks5://user:pass@host:port -- bridging them
 * keeps that off the critical path. Only CONNECT is handled; challenge pages are https.
 */
function startSocksBridge(url: URL): Promise<SocksBridge> {
  const proxy = {
    host: url.hostname,
    port: Number(url.port),
    type: (url.protocol === "socks4:" ? 4 : 5) as 4 | 5,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };

  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());

    client.once("data", async (chunk) => {
      const head = chunk.toString("latin1");
      const target = head.match(/^CONNECT\s+([^\s:]+):(\d+)/i);
      if (!target) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }
      try {
        const { socket } = await SocksClient.createConnection({
          proxy,
          command: "connect",
          // Hostname is passed through so the proxy resolves it, as socks5h does
          destination: { host: target[1], port: Number(target[2]) },
        });
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.pipe(client);
        client.pipe(socket);
      } catch {
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

/** The proxy CloakBrowser is launched with, plus whatever has to be shut down after. */
async function resolveProxy(proxyUrl?: string): Promise<{ proxy?: string; close: () => void }> {
  if (!proxyUrl) return { close: () => {} };
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    console.warn("[cfBrowser] proxy URL could not be parsed; going out direct");
    return { close: () => {} };
  }
  if (!/^socks/i.test(url.protocol) || !url.username) return { proxy: proxyUrl, close: () => {} };

  try {
    const bridge = await startSocksBridge(url);
    return { proxy: `http://127.0.0.1:${bridge.port}`, close: bridge.close };
  } catch (err: any) {
    console.error(`[cfBrowser] SOCKS bridge failed: ${err?.message ?? err}`);
    return { close: () => {} };
  }
}

// ── Launch ───────────────────────────────────────────────────────────────────

/**
 * Runs `launch` with the library pointed at a binary already on disk.
 *
 * `CLOAKBROWSER_BINARY_PATH` is the only thing that stops the library resolving a binary
 * of its own -- passing an executable through the launch options overrides which one
 * finally starts, but the resolve (and, with nothing cached for that tier, a ~200MB
 * download) has already happened by then. That download would land in the middle of a
 * job, over the connection the job is using.
 *
 * Launches are serialised through here because the setting is process-wide and two
 * concurrent ones can want different tiers. The section covers the launch call only, so
 * the queue is a second or two, and the previous value is put back for the settings page.
 */
let launchGate: Promise<unknown> = Promise.resolve();

function withBinaryPin<T>(exe: string | undefined, launch: () => Promise<T>): Promise<T> {
  const run = launchGate.then(async () => {
    const previous = process.env.CLOAKBROWSER_BINARY_PATH;
    if (exe) process.env.CLOAKBROWSER_BINARY_PATH = exe;
    try {
      return await launch();
    } finally {
      if (previous === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH;
      else process.env.CLOAKBROWSER_BINARY_PATH = previous;
    }
  });
  launchGate = run.catch(() => {});
  return run;
}

export type LaunchedBrowser = {
  context: BrowserContext;
  page: Page;
  /** Stable id of the exit this browser goes out through. */
  key: string;
  /** What that exit is called, for showing: its name in the proxy list, or `direct`. */
  proxyLabel: string;
  /** The profile it is running on, which is what decides whose cookies it has. */
  profileKey: string;
  /**
   * The device seed this launch ran on. Worth reporting: "the site still knows me" is
   * answered by whether this figure moved between runs, and nothing else on the page says.
   */
  deviceSeed: number;
  /** The locale it reported, and whether that was pinned in Settings or came from the exit. */
  locale?: string;
  localePinned: boolean;
  /** Which build is running: the licensed one, or the unlicensed fallback. */
  tier: BuildTier;
  /** What is known about where it comes out, if anything yet. */
  geo?: CfExitGeo;
  /**
   * The browser process went away on its own, rather than through `close()`. Worth asking
   * before reading anything off the page: every driver call against a dead browser answers
   * with nothing, which reads exactly like a page that rendered blank.
   */
  died: () => boolean;
  /** Closes the browser and releases the profile, bridge and everything else. */
  close: () => Promise<void>;
};

/**
 * Launches the stealth browser for one exit: headed on the shared display, on that exit's
 * own profile, with the clock and language of the country the exit comes out in.
 *
 * Timezone and locale are passed to CloakBrowser rather than emulated over CDP, because
 * the binary applies them as launch flags -- CDP emulation is itself detectable.
 */
/**
 * How long a freshly launched keyed browser is watched before it is trusted. A build that
 * cannot hold its licence session quits about a second in, so this only has to outlast that;
 * it is added to every keyed launch, which is why it is not longer.
 */
const KEYED_LIVENESS_MS = 2_500;

/**
 * Did this context close inside `waitMs`? Resolves as soon as it does, so a browser that
 * stays up costs the full wait and one that quits costs only as long as it lasted.
 */
export async function exitedAtOnce(context: BrowserContext, waitMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs);
    context.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Ceiling on a browser shutdown, so a wedged one cannot hold its licence seat. */
const CLOSE_TIMEOUT_MS = 10_000;

/** Stands in for a lease where none is taken, so the launch path stays one shape. */
const NO_LEASE: { key?: string; release: () => void } = { release: () => {} };

// Browsers currently up. A free-build launch takes no licence seat, so seat usage does not
// answer "is anything running" -- and removing a binary, or stopping the lot by hand, both
// need to know. Held as the browsers themselves so they can be closed on request.
const liveBrowsers = new Set<{
  close: () => Promise<void>;
  /** Which job run this browser belongs to, so one run can be stopped on its own. */
  runId?: string;
  /** The exit it goes out through, so a viewer watching the run can say which one. */
  proxyLabel?: string;
}>();

/** The exit a running job's browser is on, for a viewer attached to that run's screen. */
export function cfProxyLabelForRun(runId: string): string | undefined {
  for (const browser of liveBrowsers) {
    if (browser.runId === runId && browser.proxyLabel) return browser.proxyLabel;
  }
  return undefined;
}

/** How many solver browsers are open right now. */
export function cfBrowsersRunning(): number {
  return liveBrowsers.size;
}

/**
 * Closes every open solver browser. The jobs holding them fail as their pages go, which is
 * the point: this is the way out when a run has wedged and is sitting on a licence seat,
 * a profile, or a proxy that nothing else can have until it lets go.
 */
export async function stopAllCfBrowsers(): Promise<{ stopped: number }> {
  const open = [...liveBrowsers];
  // close() releases the seat, profile and proxy, and is bounded, so one wedged browser
  // cannot hold up the rest
  await Promise.all(open.map((b) => b.close().catch(() => {})));
  return { stopped: open.length };
}

/**
 * Closes the browsers one job run owns. This is what makes cancelling a browser step take
 * effect at once: the driver calls it is sitting in reject as their page goes, instead of
 * the run carrying on to the end of its budget with nobody waiting for the answer.
 */
export async function stopCfBrowsersForRun(
  runId: string,
): Promise<{ stopped: number }> {
  const open = [...liveBrowsers].filter((b) => b.runId === runId);
  await Promise.all(open.map((b) => b.close().catch(() => {})));
  if (open.length)
    console.log(`[cfBrowser] closed ${open.length} browser(s) for cancelled run ${runId}`);
  return { stopped: open.length };
}

/**
 * Kills any solver browser this process is not holding: one left by a backend that was
 * killed, or one whose context went away while its process did not. They are invisible to
 * `stopAllCfBrowsers`, and each still holds a profile directory and a licence session.
 *
 * Scoped by executable: only a binary living in this installation's own browser directory
 * is killed, so nothing else on the host is touched. Linux only, since it reads procfs;
 * elsewhere there is nothing to clean up that the supervisor will not handle.
 */
export function killStrayCfBrowsers(): { killed: number } {
  const root = cloakCacheDir();
  let killed = 0;
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return { killed: 0 };
  }
  for (const pid of pids) {
    let exe: string;
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      // Gone between the listing and the read, or owned by another user
      continue;
    }
    if (!exe.startsWith(root + path.sep)) continue;
    try {
      process.kill(Number(pid), "SIGKILL");
      killed++;
    } catch {
      /* it exited on its own, or is not ours to signal */
    }
  }
  if (killed) console.log(`[cfBrowser] killed ${killed} stray browser process(es)`);
  return { killed };
}

export async function launchCfBrowser(
  proxyUrl?: string,
  opts: {
    /**
     * Force a build rather than letting seat availability decide. Only the settings test
     * uses this, so each installed build can be exercised in turn -- a job always wants
     * the best one it can get.
     */
    tier?: BuildTier;
    /**
     * Which profile -- so which cookie jar and which device -- this browser runs on. The
     * name is a template: see `cfProfileKey`. Blank takes the configured default, which
     * ships as one profile per exit.
     */
    profile?: { template?: string; vars?: CfProfileVars };
    /**
     * Draw on this X display instead of the shared one. For a browser someone is about to
     * watch over VNC: on its own display, the viewer sees this browser and nothing else.
     */
    display?: string;
    /** The job run this browser serves, so cancelling that run can close it. */
    runId?: string;
  } = {},
): Promise<LaunchedBrowser> {
  const tune = cfTuning();
  if (!isChromiumInstalled()) {
    throw new Error(
      "The Cloudflare solver browser is not installed. Enable it in Settings to download it into the data dir.",
    );
  }

  // Before the browser is spawned: fontconfig is read from the environment it inherits.
  // A browser with no fonts measures text like nothing else on the web, which is exactly
  // the sort of thing a challenge scores against.
  applyCfFontEnv();

  const display = opts.display ?? (await ensureDisplay());
  const win = configuredWindow();
  warnIfWindowExceedsScreen(win);
  const key = exitKey(proxyUrl);
  const geo = cfExitGeo(key);
  // A pinned locale wins over the exit's own, which is the point of pinning one -- but it is
  // also why an Australian exit can keep rendering pages in another language, so which of the
  // two won is reported below and in the job log
  const pinnedLang = cfBrowserLang();
  const locale = pinnedLang ?? geo?.lang;
  // Geography follows the exit -- it is a fact about the IP, shared by everything going out
  // through it. Cookies and the device they were issued to follow the profile, whose name
  // the caller decides: see `cfProfileKey`.
  const profileKey = cfProfileKey(
    proxyUrl,
    opts.profile?.template || configuredProfileId(),
    opts.profile?.vars,
  );
  const profile = claimProfile(profileKey);
  const proxy = await resolveProxy(proxyUrl);
  // The keyed build first, on a seat of its own: one licence key is one concurrent
  // session, so a seat is held for as long as this browser lives.
  //
  // When every seat is out, what to do next depends on what is on disk. With the
  // unlicensed build installed, run on that straight away -- it needs no session, and
  // holding the job for a seat that may not come free inside its budget buys nothing over
  // an older build that starts now. With only the keyed build there, waiting is the only
  // option, since it refuses to start without a key at all.
  // A forced free build takes no seat: it needs no licence, and holding one would keep it
  // from a run that does.
  let lease = opts.tier === "free" ? NO_LEASE : await leaseCfLicenseKey();
  if (opts.tier === "keyed" && !lease.key) {
    proxy.close();
    profile.release();
    throw new Error(
      cfLicenseUsage().total
        ? "Every licence seat is in use right now, so the keyed build cannot be started for this test."
        : "No licence key is configured, so there is no keyed build to test.",
    );
  }
  const freeBuild = chromiumExecutable("free");
  if (!lease.key && opts.tier !== "free" && cfLicenseUsage().total) {
    if (freeBuild) {
      console.log("[cfBrowser] every licence seat is taken; running this one on the free build");
    } else {
      console.log("[cfBrowser] every licence seat is taken; waiting for one to free up");
      lease = await leaseCfLicenseKey(tune.budgetMs);
      if (!lease.key) {
        console.warn(
          "[cfBrowser] no licence seat came free, and there is no free build to fall back " +
            "on. Add another key in Settings, or install the free build alongside it.",
        );
      }
    }
  }

  // The build that matches whether a key is in hand: a keyed binary declines to run
  // without one, and a free one has no use for it
  const executablePath = chromiumExecutable(opts.tier ?? (lease.key ? "keyed" : "free"));
  if (!executablePath) {
    proxy.close();
    profile.release();
    lease.release();
    throw new Error(
      "No licence seat was free and there is no unlicensed build installed to fall back " +
        "on, so nothing here can run: the keyed build refuses to start without a key. " +
        "Add another licence key in Settings so more solvers can run at once, or install " +
        "the free build alongside the keyed one.",
    );
  }

  const { launchPersistentContext } = await cloak();
  const deviceSeed = fingerprintSeed(profile.seedKey);
  // Said out loud because this is what the questions are actually about: "the site still knows
  // me" comes down to whether the device moved (a kept profile holds it still on purpose, a
  // throwaway one draws a new one every run), and "the page is in the wrong language" comes
  // down to which locale won -- a pinned one beats the exit's own by design, and nothing on
  // the page says so
  console.log(
    `[cfBrowser] profile ${profileKey === CF_NO_PROFILE_KEY ? "(none, throwaway)" : profileKey}` +
      `, device ${deviceSeed}, locale ${locale ?? "(browser default)"}` +
      `${pinnedLang ? " (pinned in Settings)" : geo?.lang ? ` (from exit ${geo.loc})` : ""}` +
      `, clock ${geo?.tz ?? "(host)"}`,
  );
  const open = (exe: string | undefined, licenseKey?: string) =>
    withBinaryPin(exe, () =>
      launchPersistentContext({
        userDataDir: profile.dir,
        headless: !display,
        proxy: proxy.proxy,
        ...(licenseKey ? { licenseKey } : {}),
        // Human-like pointer curves and keystroke timing on the driver's own methods
        humanize: true,
        ...(geo?.tz ? { timezone: geo.tz } : {}),
        // A pinned locale wins over the exit's: an app that renders in the browser's
        // language is unusable to a step naming its controls in another
        ...(locale ? { locale } : {}),
        args: [
          // One machine per exit, kept across runs alongside its cookies
          // Seeded from the profile, not the bare exit: the device has to stay with the
          // cookies it was issued to, or a session comes back on a machine that has changed
          `--fingerprint=${deviceSeed}`,
          // The container has no user namespaces to sandbox into, and /dev/shm is small
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          // Render through Chromium's own bundled SwiftShader rather than the system GL
          // stack. The image purges Mesa to stay small, which leaves no GLX for ANGLE to
          // start from ("GLX is not present"), and ANGLE does not fall back on its own.
          // This keeps WebGL present, which matters: a browser reporting none reads as
          // automation. Do not drop these without putting Mesa back in the image.
          "--use-gl=angle",
          "--use-angle=swiftshader",
          // A profile that is reused must not reopen the last session or offer to restore a
          // crashed one, either of which would leave a dialog over the page
          "--no-first-run",
          "--no-default-browser-check",
          "--hide-crash-restore-bubble",
          // A window Chromium considers occluded gets its timers, rendering and observer
          // callbacks throttled, which stalls anything waiting on them
          "--window-position=0,0",
          // The page runs with no emulated viewport (CloakBrowser passes viewport: null so
          // outerWidth cannot contradict innerWidth), so the window is the viewport and this
          // flag is what sizes it. Left out entirely when unset, so Chromium picks as before.
          ...(win ? [`--window-size=${win.width},${win.height}`] : []),
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-background-timer-throttling",
        ],
        launchOptions: {
          timeout: tune.navTimeoutMs,
          executablePath: exe,
          // A display of this browser's own goes to the child's environment rather than
          // being set globally, so a job launching at the same moment is not dragged onto
          // it. It has to ride here: CloakBrowser forwards `launchOptions` to Playwright
          // but has no top-level `env` option of its own, and would drop one.
          ...(opts.display ? { env: { ...process.env, DISPLAY: opts.display } } : {}),
        },
      }),
    );

  let context: BrowserContext;
  let usedTier: BuildTier = lease.key ? "keyed" : "free";
  try {
    context = await open(executablePath, lease.key);
    // A keyed build that could not hold a licence session does not fail the launch: it comes
    // up, answers the driver, and quits about a second later -- so the run reads as a browser
    // that died mid-navigation, whatever it was pointed at. The seat is free locally, so
    // nothing here can tell the difference except by watching whether it stays. Give it a
    // moment, and treat an instant exit the way a refused launch is treated.
    if (lease.key && freeBuild && opts.tier !== "keyed") {
      const gone = await exitedAtOnce(context, KEYED_LIVENESS_MS);
      if (gone) {
        console.warn(
          "[cfBrowser] the keyed browser quit right after starting, which is what losing the " +
            "licence session looks like; falling back to the free build for this run",
        );
        await context.close().catch(() => {});
        throw new Error("the keyed build quit right after starting");
      }
    }
  } catch (err: any) {
    // The keyed build takes its licence at startup and quits on the spot when it cannot
    // hold a session -- another instance on the same key, or one the licence service has
    // not finished tearing down. The free build needs no session, so falling back to it
    // gets the job run instead of failing it outright over a seat.
    const freeExe = lease.key ? freeBuild : undefined;
    if (!freeExe) {
      proxy.close();
      profile.release();
      lease.release();
      throw err;
    }
    console.warn(
      `[cfBrowser] the keyed browser could not start (${String(err?.message ?? err).split("\n")[0]}); ` +
        "falling back to the free build for this run",
    );
    // Hand the seat straight back: this browser is not using it, and something else can
    lease.release();
    try {
      context = await open(freeExe);
      usedTier = "free";
    } catch (freeErr) {
      proxy.close();
      profile.release();
      throw freeErr;
    }
  }

  try {
    // Bounds every driver call, so one wedged renderer cannot swallow the step budget
    context.setDefaultTimeout(tune.protocolTimeoutMs);
    context.setDefaultNavigationTimeout(tune.navTimeoutMs);

    // Put the jar back before anything loads. Without this a site that signs you in with a
    // session cookie meets a signed-out visitor every run, however carefully the profile
    // itself was kept.
    const restored = await restoreCookies(context, profile.dir);
    if (restored) console.log(`[cfBrowser] restored ${restored} cookie(s) for ${profileKey}`);

    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    // A reused profile reopens the tabs the last session left behind, and they pile up run
    // after run. Worse, a restored tab may be the active one, and Chromium delivers
    // pointer presses only to the active tab.
    for (const stray of pages.slice(1)) await stray.close().catch(() => {});
    if (pages.length > 1) {
      console.log(`[cfBrowser] closed ${pages.length - 1} restored tab(s) from the saved profile`);
    }
    await page.bringToFront().catch(() => {});

    // A browser that exits mid-run leaves no exception behind: the driver calls that follow
    // are caught one by one and answer with nothing, so the run reads as a page that never
    // rendered and the exit takes the blame. This is the only honest signal that it went.
    let closing = false;
    let died = false;
    let closePromise: Promise<void> | undefined;
    context.on("close", () => {
      if (closing) return;
      died = true;
      console.warn(
        `[cfBrowser] the browser on profile ${profileKey} exited on its own. A licensed ` +
          "build does that when it loses its licence session, and any build does when its " +
          "profile is opened by a second process -- check nothing else is running against " +
          "this data dir.",
      );
    });

    const launched: LaunchedBrowser & { runId?: string } = {
      context,
      page,
      key,
      proxyLabel: proxyLabelForUrl(proxyUrl),
      runId: opts.runId,
      profileKey,
      deviceSeed,
      locale,
      localePinned: Boolean(pinnedLang),
      tier: usedTier,
      geo,
      died: () => died,
      // Once only, and callers awaiting a close already under way get that one: cancelling a
      // run closes its browsers from the outside while the run's own cleanup still runs, and
      // repeating the save-and-release would sit through both timeouts a second time
      close: () => (closePromise ??= closeOnce()),
    };

    async function closeOnce(): Promise<void> {
      closing = true;
      // Before the browser goes: its cookies, which its own store may not keep
      await Promise.race([
        saveCookies(context, profile.dir).then((n) => {
          if (n) console.log(`[cfBrowser] saved ${n} cookie(s) for ${profileKey}`);
        }),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
      // Bounded: a wedged renderer can leave close() pending, and everything below it --
      // the licence seat above all -- would then be held for the life of the process.
      await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, CLOSE_TIMEOUT_MS)),
      ]);
      proxy.close();
      profile.release();
      lease.release();
      liveBrowsers.delete(launched);
    }
    liveBrowsers.add(launched);
    return launched;
  } catch (err) {
    proxy.close();
    profile.release();
    lease.release();
    throw err;
  }
}
