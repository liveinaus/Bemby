import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readZip } from "../system/zipRead";
import { dataDir } from "./paths";

/**
 * Xray-core, installed into the data dir on demand.
 *
 * It is what carries the node kinds Bemby cannot speak itself -- VLESS behind REALITY
 * above all, which is what nearly every commercial subscription now serves. REALITY needs
 * a byte-exact TLS 1.3 ClientHello with its authentication sealed into the session id;
 * that is a TLS stack, not a parser, so the reference implementation runs it instead.
 *
 * Not in the image, for the same reason as the solver browser and the CJK fonts: it is
 * ~40MB for a feature many installs never touch, and the data dir is a volume, so an
 * install survives a restart and an upgrade.
 *
 * Xray-core is MPL-2.0 and is run as a separate process over a loopback socket, so nothing
 * here links against it.
 */

/** The release this fetches. Pinned so a published build cannot change under an install. */
export const XRAY_VERSION = process.env.XRAY_VERSION || "v26.3.27";

const RELEASE_BASE = "https://github.com/XTLS/Xray-core/releases/download";
const DOWNLOAD_TIMEOUT_MS = 300_000;
/** The core alone, unpacked. The archive's geodata is not extracted: no rule references it. */
const MAX_BINARY_BYTES = 200_000_000;

export type XrayStatus = {
  available: boolean;
  /** Where the binary came from: the data-dir install, or one already on PATH. */
  source: "data-dir" | "system" | "none";
  version?: string;
  bytes?: number;
  /** The release an install would fetch, so the panel can offer an out-of-date one. */
  latest: string;
  /** Set when this platform has no published build. */
  unsupported?: string;
};

export function xrayRoot(): string {
  return path.join(dataDir(), "xray");
}

const binaryName = (): string => (process.platform === "win32" ? "xray.exe" : "xray");

function installedBinary(): string {
  return path.join(xrayRoot(), binaryName());
}

/** The published archive for this platform, or undefined where XTLS publishes none. */
export function xrayAsset(): string | undefined {
  const slugs: Record<string, Record<string, string>> = {
    linux: { x64: "linux-64", arm64: "linux-arm64-v8a", arm: "linux-arm32-v7a" },
    darwin: { x64: "macos-64", arm64: "macos-arm64-v8a" },
    win32: { x64: "windows-64", arm64: "windows-arm64-v8a" },
  };
  const slug = slugs[process.platform]?.[process.arch];
  return slug ? `Xray-${slug}.zip` : undefined;
}

/**
 * A binary on PATH, for a host that manages its own Xray.
 *
 * Looked up once and remembered: this is asked per node while a subscription is carried,
 * and a `which` for each of a hundred nodes is a spawn per node. An install performed here
 * lands in the data dir, which is checked ahead of this and is always current, so the only
 * thing a stale answer misses is an xray put on PATH while the process is running.
 */
let pathLookup: { bin?: string } | undefined;
function systemBinary(): string | undefined {
  if (!pathLookup) {
    const found = spawnSync(process.platform === "win32" ? "where" : "which", [binaryName()], {
      encoding: "utf8",
    });
    const first = found.stdout?.trim().split("\n")[0]?.trim();
    pathLookup = { bin: found.status === 0 && first ? first : undefined };
  }
  return pathLookup.bin;
}

/** The core to run, whether it was installed here or was already on the host. */
export function xrayPath(): string | undefined {
  if (existsSync(installedBinary())) return installedBinary();
  return systemBinary();
}

export function isXrayInstalled(): boolean {
  return !!xrayPath();
}

/** The version string the binary reports, e.g. "Xray 26.3.27". */
function readVersion(bin: string): string | undefined {
  const ran = spawnSync(bin, ["version"], { encoding: "utf8", timeout: 10_000 });
  return `${ran.stdout ?? ""}${ran.stderr ?? ""}`.trim().split("\n")[0] || undefined;
}

export function xrayStatus(): XrayStatus {
  const asset = xrayAsset();
  const bin = xrayPath();
  if (!bin) {
    return {
      available: false,
      source: "none",
      latest: XRAY_VERSION,
      ...(asset ? {} : { unsupported: `${process.platform}/${process.arch}` }),
    };
  }
  const fromData = bin === installedBinary();
  let bytes: number | undefined;
  try {
    bytes = fromData ? statSync(bin).size : undefined;
  } catch {
    /* removed between the check and the stat */
  }
  return {
    available: true,
    source: fromData ? "data-dir" : "system",
    version: readVersion(bin),
    latest: XRAY_VERSION,
    ...(bytes ? { bytes } : {}),
  };
}

let installing = false;
const log: string[] = [];

export function xrayInstallLog(): { installing: boolean; log: string[] } {
  return { installing, log: [...log] };
}

/** SHA-256 the release publishes beside the archive, which is what catches a bad download. */
async function publishedDigest(asset: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${RELEASE_BASE}/${XRAY_VERSION}/${asset}.dgst`, {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return undefined;
    return /^SHA2-256=\s*([0-9a-f]{64})$/im.exec(await res.text())?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Fetches the core into the data dir.
 *
 * Returns only once the binary answers `version`: an install that cannot run is worse than
 * none, because every node would fail later and further from the cause.
 */
export async function installXray(force = false): Promise<XrayStatus> {
  if (installing) throw new Error("An install is already running");

  const asset = xrayAsset();
  if (!asset) {
    throw new Error(
      `XTLS publishes no Xray build for ${process.platform}/${process.arch}. Install one by hand and put it on PATH.`,
    );
  }
  if (!force && existsSync(installedBinary())) {
    return xrayStatus();
  }

  installing = true;
  log.length = 0;
  const note = (line: string): void => {
    log.push(line);
    if (log.length > 200) log.shift();
    console.log(`[xray] ${line}`);
  };

  try {
    mkdirSync(xrayRoot(), { recursive: true });

    const url = `${RELEASE_BASE}/${XRAY_VERSION}/${asset}`;
    note(`Fetching ${asset} (${XRAY_VERSION})...`);
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${url} returned ${res.status} ${res.statusText}`);
    const archive = Buffer.from(await res.arrayBuffer());
    note(`Downloaded ${Math.round(archive.length / 1024 / 1024)} MB`);

    const expected = await publishedDigest(asset);
    const actual = createHash("sha256").update(archive).digest("hex");
    if (expected && expected !== actual) {
      throw new Error("The download does not match the digest published with the release");
    }
    note(expected ? "Digest matches the release" : "The release published no digest to check");

    const wanted = binaryName();
    const { files } = readZip(
      archive,
      { maxEntryBytes: MAX_BINARY_BYTES, maxTotalBytes: MAX_BINARY_BYTES, maxEntries: 4 },
      (name) => name === wanted || name.endsWith(`/${wanted}`),
    );
    const binary = files.find((f) => f.name === wanted || f.name.endsWith(`/${wanted}`));
    if (!binary) throw new Error(`The archive holds no "${wanted}"`);

    // Written aside and renamed, so a half-written binary is never the one that runs
    const part = `${installedBinary()}.part`;
    writeFileSync(part, binary.data);
    chmodSync(part, 0o755);
    renameSync(part, installedBinary());
    note(`Unpacked ${Math.round(binary.data.length / 1024 / 1024)} MB`);

    const version = readVersion(installedBinary());
    if (!version) {
      rmSync(installedBinary(), { force: true });
      throw new Error("The downloaded binary would not run on this host");
    }
    note(version);
    return xrayStatus();
  } finally {
    installing = false;
  }
}

export function removeXray(): void {
  rmSync(xrayRoot(), { recursive: true, force: true });
}
