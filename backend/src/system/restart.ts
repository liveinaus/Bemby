/**
 * Restarting the backend from the panel.
 *
 * The way out when the process itself is the problem: a licence session nothing will hand
 * back, a browser wedged past what "stop all browsers" can reach, a scheduler that has to
 * start over. Everything a run holds lives in this process, so replacing it is what clears
 * the lot.
 *
 * Nothing here starts the new process. It stops the old one cleanly and lets whatever
 * supervises it bring it back: Docker's restart policy, Railway's, or systemd. Self-respawn
 * was the alternative and is worse -- the child would inherit this process's sockets and
 * race it for the instance lock.
 */
import { existsSync } from "node:fs";
import { cfBrowsersRunning, killStrayCfBrowsers, stopAllCfBrowsers } from "../jobs/cfBrowser";
import { killManualSessionNow } from "../jobs/manualBrowser";
import { markCleanShutdown } from "../monitor/memory";
import { releaseInstanceLock } from "../instanceLock";

/**
 * A non-zero code because that is what the restart policies in this repo are set to act on:
 * Railway restarts `on_failure`, and Docker's `unless-stopped` restarts either way. The
 * clean-shutdown marker is written regardless, so the next boot does not read this as a kill.
 */
const RESTART_EXIT_CODE = Number(process.env.RESTART_EXIT_CODE ?? 1);

/** Long enough for the HTTP response to reach the panel, short enough to feel immediate. */
const EXIT_DELAY_MS = 400;

export type RestartOutcome = {
  /** Browsers this process was holding, closed with their profiles and licence seats. */
  stopped: number;
  /** Browser processes killed outright rather than closed. */
  killed: number;
  /** Whether something is expected to start the process again. */
  supervised: boolean;
  /** Whether the browsers were killed where they stood instead of being closed. */
  forced: boolean;
};

/**
 * Whether this process will come back on its own. Docker and Railway both restart it;
 * a bare `npm run dev` does not, and the panel says so rather than appearing to hang.
 * BEMBY_SUPERVISED=1 declares it for anything else (systemd, pm2, a shell loop).
 */
export function restartSupervised(): boolean {
  if (process.env.BEMBY_SUPERVISED === "1") return true;
  if (process.env.BEMBY_SUPERVISED === "0") return false;
  return existsSync("/.dockerenv") || !!process.env.RAILWAY_ENVIRONMENT;
}

/**
 * Closes every browser, kills the ones no longer attached to anything, and exits.
 *
 * Returns once the shutdown work is done; the exit itself is on a timer so the caller can
 * answer the request first. Runs in flight are left interrupted on purpose: they are
 * reconciled on the next boot, and waiting for a wedged one is the reason this exists.
 *
 * `force` takes the shorter way out. The ordinary path asks each browser to close, which
 * talks to it over CDP and returns its licence seat -- worth having, but it is the browser
 * being asked, so a browser that has stopped answering is exactly what can hold it up. A
 * forced restart waits for nothing: every browser process this installation owns is killed
 * where it stands, held or stray, the manual session's viewer goes with them, and the
 * process exits. The seats are recovered by the licence service timing them out instead.
 */
export async function restartBemby(
  opts: { force?: boolean } = {},
): Promise<RestartOutcome> {
  const force = opts.force === true;
  let stopped = 0;
  let killed = 0;

  if (force) {
    // Nothing here awaits a browser. killStrayCfBrowsers matches on the executable path, so
    // in this pass it takes the live ones as well as anything an earlier backend left.
    const running = cfBrowsersRunning();
    killManualSessionNow();
    killed = killStrayCfBrowsers().killed;
    console.warn(
      `[restart] forced restart on request: killed ${killed} browser process(es) ` +
        `(${running} held by this process).`,
    );
  } else {
    stopped = (await stopAllCfBrowsers()).stopped;
    killed = killStrayCfBrowsers().killed;
    console.warn(
      `[restart] restarting on request: closed ${stopped} browser(s), killed ${killed} stray ` +
        `process(es).`,
    );
  }

  const supervised = restartSupervised();
  console.warn(
    `[restart] ${supervised ? "Waiting to be restarted." : "Nothing is set to restart this process; it will stay down until it is started again."}`,
  );

  markCleanShutdown();
  releaseInstanceLock();
  setTimeout(() => process.exit(RESTART_EXIT_CODE), EXIT_DELAY_MS).unref();

  return { stopped, killed, supervised, forced: force };
}
