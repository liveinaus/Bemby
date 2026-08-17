import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { db } from "../db/database";
import {
  CF_NO_PROFILE_KEY,
  cfProfileKey,
  cfProxyLabelForRun,
  launchCfBrowser,
  startPrivateDisplay,
  type LaunchedBrowser,
} from "./cfBrowser";
import { configuredProfileId } from "./cfBrowser";
import { vncCommand } from "./vncInstall";
import { runDisplay } from "./runDisplays";
import type { CustomAction, CustomConfig, Job } from "../types";

/**
 * A browser someone drives by hand, on the profile a job will later run on.
 *
 * The point is usually the cookie. A site that rations logins, or a challenge the solver cannot
 * get through, needs a person once -- and because the session runs on the job's own profile and
 * exits through the job's own proxy, what it leaves behind is exactly what the scheduled run
 * picks up. Anything else (a different profile, a different exit) leaves a session the site
 * will not honour for the job.
 *
 * A job on `{noProfile}` opens too, on a throwaway profile of its own, exactly as its scheduled
 * runs do. Nothing is kept, so there is no cookie to leave -- but seeing what the page does,
 * and working something by hand once, is reason enough. The session says as much rather than
 * refusing to open.
 *
 * One at a time. Each session holds a profile, a licence seat and a proxy for as long as it
 * is open, and the whole point is to watch it, which nobody does to two at once.
 */

/** Idle sessions are closed: they pin a profile, a licence seat and a proxy. */
const IDLE_TIMEOUT_MS = 15 * 60_000;

/** However long it is used for, a session does not outlive this. */
const MAX_SESSION_MS = 60 * 60_000;

/** A ticket authorises one thing -- attaching to this session's screen -- and briefly. */
const TICKET_TTL_MS = 60_000;

export type ManualSession = {
  id: string;
  /**
   * `drive` owns a browser opened for someone to use; `watch` is attached to a job that is
   * running on its own, where the pointer is the operator's only if they ask for it.
   */
  kind: "drive" | "watch";
  jobId: number;
  jobName: string;
  /** The profile it is running on, which is the whole point: the job must share it. */
  profileKey: string;
  /**
   * The exit it goes out through, by the name the proxy list gives it. Worth showing: a
   * session on another IP leaves a cookie the scheduled run may not be able to use, and
   * nothing on the screen itself says which exit is behind it.
   */
  proxyLabel?: string;
  /**
   * The job runs on `{noProfile}`, so this session has a throwaway profile of its own and
   * keeps nothing: worth saying, since a login left here goes when the browser does.
   */
  ephemeral?: boolean;
  /** Where the viewer connects, once it has a ticket. */
  vncPort: number;
  startedAt: number;
  /** Bumped while a viewer is attached, so an unattended session times out. */
  lastSeenAt: number;
  /** What the browser was pointed at. */
  url: string;
  /** The run being watched, for a `watch` session. */
  runId?: string;
};

type LiveSession = ManualSession & {
  /** Only a `drive` session owns these; a `watch` one is a guest on a run's screen. */
  browser?: LaunchedBrowser;
  vnc: ChildProcess;
  display?: { display: string; close: () => void };
  idleTimer: ReturnType<typeof setInterval>;
};

let current: LiveSession | undefined;
const tickets = new Map<string, { sessionId: string; expiresAt: number }>();

/** What a session looks like to the API: no handles, nothing to close by accident. */
function publicView(s: LiveSession): ManualSession {
  const { browser: _b, vnc: _v, display: _d, idleTimer: _t, ...rest } = s;
  return rest;
}

export function currentManualSession(): ManualSession | undefined {
  return current ? publicView(current) : undefined;
}

/** Whether a profile is being driven by hand, so the scheduler leaves that job alone. */
export function profileHeldByManualSession(profileKey: string): boolean {
  return current?.profileKey === profileKey;
}

export function manualSessionJobId(): number | undefined {
  return current?.jobId;
}

/** A short-lived, single-purpose credential for the screen socket. */
export function issueManualTicket(sessionId: string): string {
  const now = Date.now();
  for (const [id, t] of tickets) if (t.expiresAt <= now) tickets.delete(id);
  const id = randomBytes(24).toString("base64url");
  tickets.set(id, { sessionId, expiresAt: now + TICKET_TTL_MS });
  return id;
}

/** Resolves a ticket and burns it: one ticket, one attach. */
export function claimManualTicket(id: string | undefined): ManualSession | undefined {
  if (!id) return undefined;
  const ticket = tickets.get(id);
  if (!ticket) return undefined;
  tickets.delete(id);
  if (ticket.expiresAt <= Date.now()) return undefined;
  if (!current || current.id !== ticket.sessionId) return undefined;
  current.lastSeenAt = Date.now();
  return publicView(current);
}

/** Keeps the session alive while someone is watching it. */
export function touchManualSession(id: string): void {
  if (current?.id === id) current.lastSeenAt = Date.now();
}

/** The browser action a job opens with, which carries the profile name and the address. */
function browserActionOf(job: Job): CustomAction | undefined {
  if (job.jobType !== "custom" || !job.config) return undefined;
  let cfg: CustomConfig;
  try {
    cfg = JSON.parse(job.config) as CustomConfig;
  } catch {
    return undefined;
  }
  return (cfg.actions ?? []).find((a) =>
    ["open_url", "open_mini_app", "open_mini_app_url", "open_bot_menu_app"].includes(a.type),
  );
}

/** A free TCP port, asked of the OS rather than guessed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** x11vnc, serving one display on the loopback interface only. */
async function startVnc(display: string): Promise<{ proc: ChildProcess; port: number }> {
  const port = await freePort();
  // From the data dir when it was installed there, otherwise from the image
  const cmd = vncCommand();
  if (!cmd) {
    throw new Error(
      "x11vnc is not installed, so the browser cannot be shown. Install it under " +
        "Settings -> Cloudflare browser, which puts it in the data dir and keeps it across upgrades.",
    );
  }
  const proc = spawn(
    cmd.bin,
    [
      "-display", display,
      "-rfbport", String(port),
      // Never off the loopback: the bridge in front of it is what carries the session's
      // authentication, and x11vnc itself has none
      "-localhost",
      "-noipv6",
      // No password of its own for the same reason, and it must not sit there waiting
      // for a viewer that will only ever arrive through the bridge
      "-nopw",
      "-forever",
      "-shared",
      "-noxdamage",
      "-quiet",
    ],
    { stdio: "ignore", env: cmd.env },
  );

  let failed: string | undefined;
  proc.once("error", (err) => {
    failed = err.message;
  });

  // Up when it is listening, which is the only proof that matters
  for (let i = 0; i < 50; i++) {
    if (failed) break;
    if (await portOpen(port)) return { proc, port };
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(failed ?? "x11vnc did not start listening");
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

/**
 * Opens the job's browser for someone to drive.
 *
 * `proxyUrl` and the profile name come from the job, not from here: a session that goes out
 * through a different exit, or writes to a different profile, leaves a cookie the scheduled
 * run cannot use -- which would look like the login simply not sticking.
 */
export async function startManualSession(opts: {
  job: Job;
  proxyUrl?: string;
  accountId?: number;
  url?: string;
}): Promise<ManualSession> {
  if (current) {
    throw new Error(
      `A browser is already open for "${current.jobName}". Close it before opening another.`,
    );
  }

  const action = browserActionOf(opts.job);
  const template = (action as { profileId?: string } | undefined)?.profileId || configuredProfileId();
  const profileKey = cfProfileKey(opts.proxyUrl, template, {
    jobId: opts.job.id,
    templateId: opts.job.templateId ?? undefined,
    tgId: opts.accountId,
  });
  // `{noProfile}` gets its own throwaway profile, like every other run of this job does, and
  // opens as normal. It used to be refused outright, on the grounds that a login left here
  // would not survive the session -- true, but not the only reason to open a browser: seeing
  // what the page actually does, working a challenge by hand, reading an error the screenshots
  // do not show. The session says so instead of standing in the way.
  const ephemeral = profileKey === CF_NO_PROFILE_KEY;

  const url =
    opts.url?.trim() || (action as { url?: string } | undefined)?.url?.trim() || "about:blank";

  const display = await startPrivateDisplay();
  if (!display) {
    throw new Error(
      "No X display could be started, so there is nothing to show. Xvfb must be available.",
    );
  }

  let vnc: { proc: ChildProcess; port: number } | undefined;
  let browser: LaunchedBrowser | undefined;
  try {
    vnc = await startVnc(display.display);
    browser = await launchCfBrowser(opts.proxyUrl, {
      display: display.display,
      profile: { template, vars: { jobId: opts.job.id, templateId: opts.job.templateId ?? undefined, tgId: opts.accountId } },
    });
    // A throwaway profile where a kept one was asked for means a scheduled run had it open,
    // and the whole point of the session -- leaving a cookie the job will find -- would
    // silently not happen. A job on `{noProfile}` asked for a throwaway, so it matches.
    if (browser.profileKey !== profileKey) {
      throw new Error(
        `The profile "${profileKey}" is in use by a running job, so this session would not ` +
          "leave a cookie that job can use. Wait for it to finish and try again.",
      );
    }
    if (url !== "about:blank") {
      await browser.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    }
  } catch (err) {
    await browser?.close().catch(() => {});
    vnc?.proc.kill();
    display.close();
    throw err;
  }

  const session: LiveSession = {
    id: randomBytes(12).toString("base64url"),
    kind: "drive",
    jobId: opts.job.id,
    jobName: opts.job.name,
    profileKey: browser.profileKey,
    proxyLabel: browser.proxyLabel,
    ...(ephemeral ? { ephemeral: true } : {}),
    vncPort: vnc.port,
    startedAt: Date.now(),
    lastSeenAt: Date.now(),
    url,
    browser,
    vnc: vnc.proc,
    display,
    idleTimer: setInterval(() => {
      if (!current) return;
      const idleFor = Date.now() - current.lastSeenAt;
      const openFor = Date.now() - current.startedAt;
      if (idleFor > IDLE_TIMEOUT_MS || openFor > MAX_SESSION_MS) {
        console.log(
          `[manual] closing the session on ${current.profileKey} ` +
            `(${idleFor > IDLE_TIMEOUT_MS ? "idle" : "open too long"})`,
        );
        void stopManualSession();
      }
    }, 30_000),
  };
  current = session;
  console.log(
    `[manual] browser open for job ${session.jobId} on profile ` +
      `${ephemeral ? "(none, throwaway -- nothing is kept)" : session.profileKey}`,
  );
  return publicView(session);
}

/**
 * Attaches a viewer to a job that is already running, on the display that run owns.
 *
 * Nothing is launched and nothing is claimed: the run keeps its browser and its screen, and
 * closing the viewer leaves both alone. The pointer does reach the run's browser, which is
 * the point -- a challenge it cannot pass is one a person can, without the run being
 * restarted -- so the panel opens it view-only and lets the operator take over deliberately.
 */
export async function watchRun(runId: string): Promise<ManualSession> {
  if (current) {
    throw new Error(
      `A screen is already open for "${current.jobName}". Close it before opening another.`,
    );
  }
  const run = runDisplay(runId);
  if (!run) throw new Error("That run is no longer showing a screen");

  const vnc = await startVnc(run.display);
  const session: LiveSession = {
    id: randomBytes(12).toString("base64url"),
    kind: "watch",
    jobId: run.jobId ?? 0,
    jobName: run.jobName ?? `Run ${runId}`,
    profileKey: "",
    // The run owns the browser, so its exit is read off that rather than worked out again:
    // a job on a random pick drew its exit once, and drawing a second time would name another
    ...(cfProxyLabelForRun(runId) ? { proxyLabel: cfProxyLabelForRun(runId) } : {}),
    vncPort: vnc.port,
    startedAt: Date.now(),
    lastSeenAt: Date.now(),
    url: "",
    runId,
    vnc: vnc.proc,
    idleTimer: setInterval(() => {
      if (!current) return;
      // A watch session holds nothing the run needs, so it only has to end when the run does
      if (!runDisplay(runId)) {
        console.log("[manual] the run being watched has finished; closing the viewer");
        void stopManualSession();
        return;
      }
      if (Date.now() - current.lastSeenAt > IDLE_TIMEOUT_MS) void stopManualSession();
    }, 15_000),
  };
  current = session;
  console.log(`[manual] watching run ${runId} on ${run.display}`);
  return publicView(session);
}

/**
 * Points the open browser at an address.
 *
 * There is no address bar in the browser itself: it runs without a window manager, and the
 * page steps normally decide where it goes. This is how a person driving it says where to
 * start -- the site's login page, most usefully.
 */
export async function gotoManualSession(url: string): Promise<string> {
  if (!current) throw new Error("No browser is open");
  const target = url.trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error(`The address must start with http:// or https:// (got "${target}")`);
  }
  const page = current.browser?.page;
  if (!page) {
    throw new Error("This screen belongs to a running job, which decides where it goes");
  }
  current.lastSeenAt = Date.now();
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
  current.url = page.url();
  return current.url;
}

/** Closes the session, releasing the profile so the job can run on it again. */
export async function stopManualSession(): Promise<void> {
  const session = current;
  if (!session) return;
  current = undefined;
  clearInterval(session.idleTimer);
  for (const [id, t] of tickets) if (t.sessionId === session.id) tickets.delete(id);
  // The browser first: closing it is what saves the cookies this was all for. A watch
  // session owns neither the browser nor the screen -- the run does, and keeps them.
  await session.browser?.close().catch(() => {});
  session.vnc.kill();
  session.display?.close();
  console.log(`[manual] closed the session on ${session.profileKey}`);
}

/**
 * Ends the session without waiting on the browser. For a forced restart: the browser process
 * is killed with the rest, so asking it to close first only risks the wait this is avoiding.
 * The cookies of an unsaved session are lost, which is the trade a forced restart is making.
 */
export function killManualSessionNow(): void {
  const session = current;
  if (!session) return;
  current = undefined;
  clearInterval(session.idleTimer);
  for (const [id, t] of tickets) if (t.sessionId === session.id) tickets.delete(id);
  session.vnc.kill("SIGKILL");
  session.display?.close();
  console.log(`[manual] killed the session on ${session.profileKey}`);
}

// A session outliving the process would hold its profile with nothing left to close it
for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (!current) return;
    current.vnc.kill();
    current.display?.close();
  });
}

/** The job row a session is asked for, or undefined when it is gone. */
export function jobById(id: number): Job | undefined {
  const row = db
    .prepare(
      `SELECT id, name, account_id as accountId, job_type as jobType, bot_username as botUsername,
              config, template_id as templateId FROM jobs WHERE id = ?`,
    )
    .get(id) as Job | undefined;
  return row;
}
