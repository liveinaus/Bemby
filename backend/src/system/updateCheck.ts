import { db } from "../db/database";
import { buildInfo, isNewer, type ReleaseChannel } from "./version";

// Whether a newer build has been published, and nothing more than that.
//
// The panel shows what is running, what is out, and the command to take it -- the pull and
// the recreate stay with whoever runs the container. A process inside a container cannot
// replace the container it is running in, and the alternative, handing this app the Docker
// socket, is host root for something that drives a browser against hostile pages.
//
// Only the running build's own line is consulted: a stable install is never told that a dev
// tag is newer than it.

const REPO = process.env.BEMBY_UPDATE_REPO ?? "liveinaus/Bemby";
const API = `https://api.github.com/repos/${REPO}`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const TIMEOUT_MS = 10_000;

/** How long an answer stands. GitHub allows 60 unauthenticated calls an hour per address. */
const TTL_MS = 6 * 60 * 60 * 1000;

/** Setting key; absent counts as on, so the check works on an install that never touched it. */
export const UPDATE_CHECK_KEY = "update_check_enabled";

export type UpdateStatus = {
  /** What is running. Empty when this is not a published image. */
  current: string;
  channel: ReleaseChannel;
  /** Newest published build on this channel, or "" when it could not be worked out. */
  latest: string;
  updateAvailable: boolean;
  /** Where to read what changed. */
  url: string;
  /** When the answer was fetched, epoch ms; 0 when nothing has been fetched yet. */
  checkedAt: number;
  /** Why there is no answer: the check is off, this build is unstamped, or the fetch failed. */
  reason?: "disabled" | "unstamped" | "error";
  error?: string;
};

export function updateCheckEnabled(): boolean {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(UPDATE_CHECK_KEY) as { value: string } | undefined;
    return row?.value !== "false";
  } catch {
    return true;
  }
}

let cache: { at: number; status: UpdateStatus } | null = null;

/** Test seam: forget the last answer. */
export function resetUpdateCache(): void {
  cache = null;
}

async function github(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      // GitHub turns away a request that names no client
      "User-Agent": "Bemby",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? "GitHub is rate-limiting this address; the next check will try again later"
        : `GitHub returned ${res.status}`,
    );
  }
  return res.json();
}

/**
 * Newest tag published on this channel.
 *
 * Stable comes from the release itself, because that is what the publish workflow builds on:
 * a tag pushed without a release has no image behind it and must not read as available. The
 * other two lines are built from a tag push and have no release, so they are read from the
 * tag list instead.
 */
async function latestOnChannel(channel: ReleaseChannel): Promise<string> {
  if (channel === "latest") {
    const release = (await github("/releases/latest")) as { tag_name?: string };
    return release?.tag_name?.trim() ?? "";
  }
  const tags = (await github("/tags?per_page=100")) as Array<{ name?: string }>;
  const wanted =
    channel === "dev" ? /^dev-/i : /^v?\d+\.\d+\.\d+-beta/i;
  const names = (Array.isArray(tags) ? tags : [])
    .map((t) => t?.name?.trim() ?? "")
    .filter((name) => name && wanted.test(name));
  // The list arrives in the repository's own order, which is not version order
  return names.reduce((newest, name) => (!newest || isNewer(newest, name) ? name : newest), "");
}

function quiet(reason: UpdateStatus["reason"], error?: string): UpdateStatus {
  const { version, channel } = buildInfo();
  return {
    current: version,
    channel,
    latest: "",
    updateAvailable: false,
    url: RELEASES_URL,
    checkedAt: 0,
    reason,
    error,
  };
}

/**
 * The last answer, fetching a new one when it has gone stale. `force` ignores the cache, for
 * the panel's own "check now"; a failure is reported rather than thrown, since being unable
 * to reach GitHub is not an error the operator has to act on.
 */
export async function updateStatus(force = false): Promise<UpdateStatus> {
  if (!updateCheckEnabled()) return quiet("disabled");
  const { version, channel, stamped } = buildInfo();
  // A source checkout or a locally built image has nothing meaningful to compare
  if (!stamped) return quiet("unstamped");

  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.status;

  try {
    const latest = await latestOnChannel(channel);
    const status: UpdateStatus = {
      current: version,
      channel,
      latest,
      updateAvailable: Boolean(latest) && isNewer(version, latest),
      url: RELEASES_URL,
      checkedAt: Date.now(),
    };
    cache = { at: status.checkedAt, status };
    return status;
  } catch (err: any) {
    // Kept out of the cache, so the next look tries again rather than waiting out the TTL
    return quiet("error", err?.message ?? String(err));
  }
}
