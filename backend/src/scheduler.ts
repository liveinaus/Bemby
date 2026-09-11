import {
  db,
  getDefaultTgApiCredentials,
  getDefaultTimezone,
  runOnce,
  FALLBACK_TIMEZONE,
} from "./db/database";
import { decryptSecret } from "./db/secretColumns";
import { iconFromConfig } from "./jobs/configIcon";
import { runJob, type JobDetailLog } from "./jobs/runner";
import { manualSessionJobId } from "./jobs/manualBrowser";
import {
  notifyJobEvent,
  buildFailureMessage,
  buildSuccessMessage,
} from "./jobs/notify";
import type { Job, TgAccount } from "./types";
import { DateTime, IANAZone } from "luxon";
import {
  registerJob,
  unregisterJob,
  registerLiveDetail,
  clearLiveDetail,
  cancelJob,
  runningLogIds,
} from "./jobs/cancellation";
import { toMinutes, pickNextRun } from "./scheduler-utils";
import { collectRunWarnings, completedMessage } from "./jobs/runWarnings";
import { recordJobSuccess } from "./jobs/jobSuccess";
import {
  prepareRunDetail,
  deleteRunShots,
  pruneOrphanRunShots,
  boundRunImages,
  externaliseRunImages,
  runShotsBytes,
  keepScreenshotsSetting,
} from "./jobs/runDetail";

type ScheduleEntry = {
  job: Job;
  account: TgAccount | null;
  /** Timezone the nextRun was computed in, after resolving the default. */
  timezone: string;
  nextRun: Date;
  timer: ReturnType<typeof setTimeout>;
};

const schedule = new Map<number, ScheduleEntry>();

/** Node's setTimeout delay is a 32-bit signed int; larger values overflow and
 * fire almost immediately (coerced to 1ms). See issue #25. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * setTimeout for delays that may exceed Node's 32-bit limit (~24.8 days).
 * Chains timers, re-arming until the remaining delay fits. `onTimer` is called
 * with each armed timer handle so the caller can keep a clearable reference to
 * the currently-pending timer.
 */
function armLongTimeout(
  delayMs: number,
  callback: () => void,
  onTimer: (timer: ReturnType<typeof setTimeout>) => void,
): void {
  if (delayMs <= MAX_TIMEOUT_MS) {
    onTimer(setTimeout(callback, delayMs));
    return;
  }
  onTimer(
    setTimeout(
      () => armLongTimeout(delayMs - MAX_TIMEOUT_MS, callback, onTimer),
      MAX_TIMEOUT_MS,
    ),
  );
}

export const DEFAULT_SCHEDULE_GAP_MINUTES = 2;
const MAX_SCHEDULE_GAP_MINUTES = 30;

/** Minimum minutes between scheduled runs. 0 disables staggering. */
export function getScheduleGapMinutes(): number {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'schedule_min_gap_minutes'")
    .get() as { value: string } | undefined;
  if (row?.value == null || row.value === "")
    return DEFAULT_SCHEDULE_GAP_MINUTES;
  const n = Number(row.value);
  if (!Number.isFinite(n)) return DEFAULT_SCHEDULE_GAP_MINUTES;
  return Math.min(MAX_SCHEDULE_GAP_MINUTES, Math.max(0, Math.floor(n)));
}

// Cap on simultaneous job executions -- colliding timers queue instead of
// thundering the Telegram client all at once.
const MAX_CONCURRENT_JOBS = 2;
let runningJobs = 0;
const waitingJobs: Array<() => void> = [];

/**
 * A job that has waited this long for a slot says the runs ahead of it are not coming back.
 * Two stuck runs fill the cap and every later job queues silently behind them, so the
 * scheduler looks idle when it is actually wedged -- this is what puts that in the log.
 */
const SLOT_WAIT_WARN_MS = 10 * 60 * 1000;

async function acquireRunSlot(jobName: string): Promise<void> {
  if (runningJobs < MAX_CONCURRENT_JOBS) {
    runningJobs++;
    return;
  }
  const warn = setTimeout(() => {
    console.warn(
      `[scheduler] "${jobName}" has waited ${SLOT_WAIT_WARN_MS / 60_000} min for one of ` +
        `${MAX_CONCURRENT_JOBS} run slot(s); ${waitingJobs.length} job(s) queued behind ` +
        `run(s) ${runningLogIds().join(", ") || "(none registered)"}`,
    );
  }, SLOT_WAIT_WARN_MS);
  warn.unref?.();
  // Slot is handed over directly by releaseRunSlot, so no counter change here
  await new Promise<void>((resolve) => waitingJobs.push(resolve));
  clearTimeout(warn);
}

function releaseRunSlot(): void {
  const next = waitingJobs.shift();
  if (next) next();
  else runningJobs--;
}

/** How the run slots are doing; served at GET /api/status/slots. */
export function runSlotUsage(): {
  held: number;
  waiting: number;
  max: number;
} {
  return {
    held: runningJobs,
    waiting: waitingJobs.length,
    max: MAX_CONCURRENT_JOBS,
  };
}

export const DEFAULT_MAX_RUN_MINUTES = 120;
const MAX_MAX_RUN_MINUTES = 24 * 60;

/**
 * Wall-clock ceiling on one run. Aborting is cooperative and not every wait takes notice of
 * it, so a run sitting in a driver or network call that never returns would otherwise hold
 * its slot for the life of the process. Well clear of any real run -- a watch job's budget
 * is minutes -- so reaching it means the run is not coming back.
 */
export function getMaxRunMinutes(): number {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'max_run_minutes'")
    .get() as { value: string } | undefined;
  if (row?.value == null || row.value === "") return DEFAULT_MAX_RUN_MINUTES;
  const n = Number(row.value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RUN_MINUTES;
  return Math.min(MAX_MAX_RUN_MINUTES, Math.floor(n));
}

/**
 * How long a run has to unwind after being asked to stop before its slot is taken back.
 * Matches the grace the cancel endpoint gives the row, so a run marked force stopped there
 * stops occupying the cap at about the same moment.
 */
const DETACH_GRACE_MS = 20_000;

/**
 * Awaits a run, but gives up on it rather than holding its slot forever.
 *
 * Whichever comes first -- an operator cancel that the run ignores, or the run passing its
 * ceiling -- the run is asked to stop, given a grace period, and then abandoned. The promise
 * is left to settle whenever it likes; its late writes are already no-ops, because every
 * update below is guarded on the row still being 'running'.
 */
function awaitRunBounded(
  run: Promise<void>,
  signal: AbortSignal,
  logId: number,
  jobName: string,
): Promise<void> {
  // Read once, so the limit the messages quote is the one that was actually applied
  const limitMinutes = getMaxRunMinutes();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      if (err === undefined) resolve();
      else reject(err);
    };
    // Attached now, so an abandoned run rejecting later is still a handled rejection
    Promise.resolve(run).then(() => finish(), finish);

    let overran = false;
    const detachAfterGrace = () => {
      const timer = setTimeout(() => {
        console.warn(
          `[scheduler] "${jobName}" (run ${logId}) did not stop when asked; ` +
            `abandoning it so its run slot is not held`,
        );
        finish(
          new Error(
            overran
              ? `Run abandoned after passing the ${limitMinutes} minute limit`
              : "Job cancelled",
          ),
        );
      }, DETACH_GRACE_MS);
      timer.unref?.();
      timers.push(timer);
    };

    if (signal.aborted) detachAfterGrace();
    else signal.addEventListener("abort", detachAfterGrace, { once: true });

    const ceiling = setTimeout(() => {
      overran = true;
      console.warn(
        `[scheduler] "${jobName}" (run ${logId}) passed its ${limitMinutes} minute ` +
          `limit; asking it to stop`,
      );
      // Unwinds the cooperative waits and closes the run's browsers; the abort listener
      // above then arms the grace, so this settles either way
      cancelJob(logId);
    }, limitMinutes * 60_000);
    ceiling.unref?.();
    timers.push(ceiling);
  });
}

/**
 * Resolves a job's timezone for scheduling. Empty means "follow the
 * default_timezone setting"; invalid zones fall back rather than producing
 * NaN timers.
 */
export function resolveJobTimezone(jobTimezone: string | null | undefined): string {
  const tz = jobTimezone || getDefaultTimezone();
  if (IANAZone.isValidZone(tz)) return tz;
  const fallback = getDefaultTimezone();
  return IANAZone.isValidZone(fallback) ? fallback : FALLBACK_TIMEZONE;
}

/** How many screenshots a run's log keeps, when the operator has set a number. */
export function keepScreenshots(): number | null {
  return keepScreenshotsSetting((key) => {
    try {
      return (
        db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
          | { value: string }
          | undefined
      )?.value;
    } catch {
      // A run's log must not be lost over a settings read; the byte budget still applies
      return undefined;
    }
  });
}

function checkDailyRunEnabled(): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'check_daily_run'")
    .get() as { value: string } | undefined;
  return row?.value !== "false";
}

// Small deterministic PRNG (FNV-1a hash seed -> mulberry32 step) so a run-every
// range resolves to a value that is stable for a given seed, not re-rolled on
// every scheduler refresh.
function seededRandom(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = (h + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Resolve the effective interval from a [min, max] range for a given seed. A
// null/absent max (or max <= min) yields the fixed min, preserving the old
// single-value behaviour exactly.
function intervalFromSeed(
  min: number,
  max: number | null | undefined,
  seed: string,
): number {
  const lo = Math.max(1, Math.floor(min));
  const hi = max != null ? Math.floor(max) : lo;
  if (hi <= lo) return lo;
  return lo + Math.floor(seededRandom(seed) * (hi - lo + 1));
}

/**
 * When the job last succeeded. `jobs.last_success_at` is the durable stamp and job_logs the
 * fallback for rows written before it existed -- the logs are pruned by the retention
 * setting, so reading them alone would make a long-interval job look never-run and reset
 * its cadence on the next restart.
 */
function lastSuccessAt(jobId: number): string | null {
  try {
    const stamp =
      (
        db.prepare("SELECT last_success_at FROM jobs WHERE id = ?").get(jobId) as
          | { last_success_at: string | null }
          | undefined
      )?.last_success_at ?? null;
    // Every success path stamps the column, so the log scan below is only for history
    // written before it existed -- which the migration backfilled anyway.
    if (stamp) return stamp;
  } catch {
    // Column not there yet (a database opened before the migration): logs still answer.
  }
  return (
    (
      db
        .prepare(
          "SELECT ran_at FROM job_logs WHERE job_id = ? AND status = 'success' ORDER BY ran_at DESC LIMIT 1",
        )
        .get(jobId) as { ran_at: string } | undefined
    )?.ran_at ?? null
  );
}

/**
 * Stamps the planned run on the job so a restart re-arms the same plan. Isolated: a write
 * failure must not stop the job being scheduled in memory.
 */
function persistNextRun(jobId: number, iso: string | null): void {
  try {
    db.prepare("UPDATE jobs SET next_run_at = ? WHERE id = ?").run(iso, jobId);
  } catch (e) {
    console.warn(`[scheduler] job ${jobId} next-run stamp failed:`, e);
  }
}

/** The plan a previous process left behind, if any. */
function storedNextRun(jobId: number): DateTime | null {
  let raw: string | null = null;
  try {
    raw =
      (
        db.prepare("SELECT next_run_at FROM jobs WHERE id = ?").get(jobId) as
          | { next_run_at: string | null }
          | undefined
      )?.next_run_at ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  const when = DateTime.fromISO(raw);
  return when.isValid ? when : null;
}

/**
 * Whether a stored plan still sits inside the job's window. The window (or the timezone it
 * is read in) can be edited while the process is down, which would leave the stored run at
 * an hour the job is no longer meant to run at.
 */
function planFitsWindow(job: Job, when: DateTime, tz: string): boolean {
  const local = when.setZone(tz);
  const minuteOfDay = local.hour * 60 + local.minute;
  return (
    minuteOfDay >= toMinutes(job.scheduleWindowStart) &&
    minuteOfDay < toMinutes(job.scheduleWindowEnd)
  );
}

/**
 * The interval to defer by after a run, resolved from the range. Seeded by the
 * job's last successful run so the value stays stable across refreshes/restarts
 * within a cycle and re-rolls only once a new successful run is recorded.
 */
export function resolveRunEveryDays(
  jobId: number,
  min: number,
  max?: number | null,
): number {
  return intervalFromSeed(min, max, `${jobId}:${lastSuccessAt(jobId) ?? "first"}`);
}

export function daysUntilNextRun(
  jobId: number,
  tz: string,
  runEveryDays: number,
  runEveryDaysMax?: number | null,
): number {
  const ranAt = lastSuccessAt(jobId);
  if (!ranAt) return 0;
  // Same seed as resolveRunEveryDays so the scheduled date is consistent whether
  // it was set after a run or recomputed on restart.
  const runEvery = intervalFromSeed(
    runEveryDays,
    runEveryDaysMax,
    `${jobId}:${ranAt}`,
  );
  const lastRun = DateTime.fromISO(ranAt, { zone: "utc" })
    .setZone(tz)
    .startOf("day");
  const today = DateTime.now().setZone(tz).startOf("day");
  const daysSince = Math.floor(today.diff(lastRun, "days").days);
  return daysSince >= runEvery ? 0 : runEvery - daysSince;
}

export function loadEligibleJobs(): Array<{
  job: Job;
  account: TgAccount | null;
}> {
  const rows = db
    .prepare(
      `
    SELECT j.*,
           a.api_id, a.api_hash, a.session_string, a.auth_status, a.proxy_id AS account_proxy_id,
           a.name AS account_name, a.phone_number, a.created_at AS account_created_at, a.disabled AS account_disabled,
           a.app_client_id AS account_app_client_id
    FROM jobs j
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    WHERE j.enabled = 1
      AND j.retired IS NULL
      AND (j.account_id IS NULL OR (a.id IS NOT NULL AND a.disabled = 0))
      AND (
        (j.job_type NOT IN ('checkin', 'custom', 'autoreg'))
        OR (a.auth_status = 'authenticated' AND a.session_string IS NOT NULL)
      )
  `,
    )
    .all() as any[];

  // Looked up once for the whole batch rather than per job, and only if a job actually
  // needs it: it is a settings read and a decrypt, and a busy install refreshes a few
  // hundred jobs at a time.
  let fallbackCredentials: ReturnType<typeof getDefaultTgApiCredentials> | undefined;
  const defaultCredentials = () =>
    (fallbackCredentials ??= getDefaultTgApiCredentials()) ?? null;

  return rows.map((row) => ({
    job: {
      id: row.id,
      name: row.name,
      accountId: row.account_id ?? null,
      jobType: row.job_type,
      botUsername: row.bot_username,
      scheduleWindowStart: row.schedule_window_start,
      scheduleWindowEnd: row.schedule_window_end,
      timezone: row.timezone,
      replyTimeoutMs: row.reply_timeout_ms,
      retryMax: row.retry_max,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      config: row.config ?? null,
      startCommand: row.start_command || "/start",
      checkinButton: row.checkin_button || "签到",
      runEveryDays: row.run_every_days ?? 1,
      runEveryDaysMax: row.run_every_days_max ?? null,
      oneTime: Boolean(row.one_time),
      icon: iconFromConfig(row.config),
    } as Job,
    account:
      row.account_id != null
        ? (() => {
            // Credentials resolve as a pair: the account's own if complete, else global defaults
            const ownApiHash = decryptSecret(row.api_hash as string | null);
            const ownCredentials =
              row.api_id && ownApiHash
                ? { apiId: row.api_id, apiHash: ownApiHash }
                : null;
            const credentials = ownCredentials ?? defaultCredentials();
            return {
              id: row.account_id,
              name: row.account_name,
              phoneNumber: row.phone_number,
              apiId: credentials?.apiId ?? null,
              apiHash: credentials?.apiHash ?? null,
              sessionString: decryptSecret(row.session_string),
              authStatus: row.auth_status,
              proxyId: row.account_proxy_id ?? null,
              disabled: Boolean(row.account_disabled),
              appClientId: row.account_app_client_id ?? null,
              createdAt: row.account_created_at,
            } as TgAccount;
          })()
        : null,
  }));
}

export async function executeJob(
  job: Job,
  account: TgAccount | null,
): Promise<void> {
  await acquireRunSlot(job.name);
  const detailLogs: JobDetailLog[] = [];
  let logId: number | bigint | undefined;
  let succeeded = false;
  try {
    // Re-fetch job settings so changes made after scheduling take effect
    const freshJob = db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(job.id) as any;
    if (freshJob) {
      job = {
        id: freshJob.id,
        name: freshJob.name,
        accountId: freshJob.account_id ?? null,
        jobType: freshJob.job_type,
        botUsername: freshJob.bot_username,
        scheduleWindowStart: freshJob.schedule_window_start,
        scheduleWindowEnd: freshJob.schedule_window_end,
        timezone: freshJob.timezone,
        replyTimeoutMs: freshJob.reply_timeout_ms,
        retryMax: freshJob.retry_max,
        enabled: Boolean(freshJob.enabled),
        createdAt: freshJob.created_at,
        config: freshJob.config ?? null,
        startCommand: freshJob.start_command || "/start",
        checkinButton: freshJob.checkin_button || "签到",
        templateId: freshJob.template_id ?? null,
        runEveryDays: freshJob.run_every_days ?? 1,
        runEveryDaysMax: freshJob.run_every_days_max ?? null,
        oneTime: Boolean(freshJob.one_time),
      };
    }

    // A browser open by hand holds that job's profile. Running anyway would hand this one a
    // throwaway profile -- a logged-out visitor -- and quietly undo what the session is for.
    const manualJobId = manualSessionJobId();
    if (manualJobId === job.id) {
      const ranAt = new Date().toISOString();
      db.prepare(
        "INSERT INTO job_logs (job_id, ran_at, status, message) VALUES (?, ?, 'failed', ?)",
      ).run(
        job.id,
        ranAt,
        "Skipped: a browser is open for this job. Close it to let the job run again.",
      );
      console.log(`[scheduler] skipping job ${job.id}: its browser is open for manual use`);
      return;
    }

    const ranAt = new Date().toISOString();
    logId = db
      .prepare(
        "INSERT INTO job_logs (job_id, ran_at, status, message) VALUES (?, ?, 'running', 'Scheduled')",
      )
      .run(job.id, ranAt).lastInsertRowid;

    const signal = registerJob(Number(logId));
    registerLiveDetail(Number(logId), detailLogs);

    // Re-fetch session in case it was updated since scheduling
    if (account) {
      const fresh = db
        .prepare("SELECT session_string FROM tg_accounts WHERE id = ?")
        .get(account.id) as any;
      if (fresh?.session_string)
        account = { ...account, sessionString: decryptSecret(fresh.session_string) };
    }

    await awaitRunBounded(
      runJob(job, account, detailLogs, signal),
      signal,
      Number(logId),
      job.name,
    );
    const stored = prepareRunDetail(logId, detailLogs, keepScreenshots());
    // Warnings ride along with a successful run: the job completed, so failing it
    // would be wrong, but the log should say what didn't work.
    const warnings = collectRunWarnings(job.jobType, detailLogs);
    // Only while the row is still open, so a cancel that already settled it stands
    db.prepare(
      "UPDATE job_logs SET status = 'success', message = ?, detail = ?, detail_bytes = ? WHERE id = ? AND status = 'running'",
    ).run(completedMessage(warnings), stored.detail, stored.bytes, logId);
    if (warnings.length) console.warn(`[scheduler] "${job.name}" completed with warnings: ${warnings.join('; ')}`);
    // Stamps the success and, for a one-time job, switches it off. The finally block
    // below re-reads `enabled`, so a job switched off here does not re-arm its timer.
    recordJobSuccess(job, ranAt);
    succeeded = true;
    console.log(`[scheduler] "${job.name}" completed`);
    void notifyJobEvent(
      "success",
      buildSuccessMessage(job.name, job.jobType),
      account,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isCancelled = message === "Job cancelled";
    if (logId !== undefined) {
      const stored = prepareRunDetail(logId, detailLogs, keepScreenshots());
      db.prepare(
        "UPDATE job_logs SET status = 'failed', message = ?, detail = ?, detail_bytes = ? WHERE id = ? AND status = 'running'",
      ).run(isCancelled ? "Cancelled" : message, stored.detail, stored.bytes, logId);
    }
    console.error(`[scheduler] "${job.name}" failed:`, message);
    if (!isCancelled) {
      void notifyJobEvent(
        "failed",
        buildFailureMessage(job.name, job.jobType, message),
        account,
      );
    }
  } finally {
    releaseRunSlot();
    if (logId !== undefined) {
      unregisterJob(Number(logId));
      clearLiveDetail(Number(logId));
    }
    // Only re-arm the timer if the job still exists and is enabled — a job
    // disabled or deleted mid-run must not reschedule itself (refreshJobs is
    // the authority and would otherwise not catch it before the next fire).
    const current = db
      .prepare("SELECT enabled FROM jobs WHERE id = ?")
      .get(job.id) as { enabled: number } | undefined;
    if (current?.enabled) {
      // The run-every-days interval spaces out *successful* runs, so a failed attempt tries
      // again the next day rather than giving up the whole interval it never earned.
      const daysAhead = succeeded
        ? resolveRunEveryDays(job.id, job.runEveryDays ?? 1, job.runEveryDaysMax)
        : 1;
      scheduleOne(job, account, daysAhead);
    }
  }
}

/** Arms the timer for an already-decided run and records it as the job's plan. */
function armRun(
  job: Job,
  account: TgAccount | null,
  timezone: string,
  nextRun: DateTime,
  catchUp = false,
): void {
  const existing = schedule.get(job.id);
  if (existing) clearTimeout(existing.timer);

  const delayMs = Math.max(0, nextRun.toMillis() - Date.now());

  let timer!: ReturnType<typeof setTimeout>;
  armLongTimeout(
    delayMs,
    () => executeJob(job, account),
    (t) => {
      timer = t;
      const entry = schedule.get(job.id);
      if (entry) entry.timer = t;
    },
  );
  schedule.set(job.id, {
    job,
    account,
    timezone,
    nextRun: nextRun.toJSDate(),
    timer,
  });
  persistNextRun(job.id, nextRun.toUTC().toISO());

  console.log(
    `[scheduler] "${job.name}"${catchUp ? " catching up today's missed run;" : ""} ` +
      `next run: ${nextRun.toISO()} (in ${Math.round(delayMs / 60_000)} min)`,
  );
}

function scheduleOne(
  job: Job,
  account: TgAccount | null,
  daysAhead = 0,
  catchUp = false,
): void {
  // Stagger away from every other job's slot so runs don't pile into the
  // same minute (issue #10)
  const occupied = Array.from(schedule.values())
    .filter((entry) => entry.job.id !== job.id)
    .map((entry) => entry.nextRun.getTime());

  const timezone = resolveJobTimezone(job.timezone);
  const nextRun = pickNextRun(
    job.scheduleWindowStart,
    job.scheduleWindowEnd,
    timezone,
    daysAhead,
    { occupied, gapMinutes: getScheduleGapMinutes(), catchUp },
  );
  armRun(job, account, timezone, nextRun, catchUp);
}

/**
 * Whether today's run was promised and never happened.
 *
 * The stored plan is the promise: a run that went ahead rewrites it on the way out, so a plan
 * still sitting in today's past means the run was lost -- the process was killed mid-day, or
 * it wedged. Guarded on the success stamp so a job that did run today is never sent again.
 */
function missedTodaysRun(jobId: number, tz: string): boolean {
  const stored = storedNextRun(jobId);
  if (!stored) return false;
  const today = DateTime.now().setZone(tz).startOf("day");
  const planned = stored.setZone(tz);
  if (planned >= DateTime.now() || !planned.startOf("day").equals(today))
    return false;

  const ranAt = lastSuccessAt(jobId);
  if (!ranAt) return true;
  return !DateTime.fromISO(ranAt, { zone: "utc" })
    .setZone(tz)
    .startOf("day")
    .equals(today);
}

function refreshJobs(): void {
  const eligible = loadEligibleJobs();
  const eligibleIds = new Set(eligible.map((e) => e.job.id));

  // Remove jobs no longer eligible
  for (const [id, entry] of schedule) {
    if (!eligibleIds.has(id)) {
      clearTimeout(entry.timer);
      schedule.delete(id);
      // Drop the stored plan too: a job switched off now keeps no claim on a date, so
      // re-enabling it later goes back through the interval.
      persistNextRun(id, null);
      console.log(`[scheduler] Unscheduled job ${id}`);
    }
  }

  const dailyCheckOn = checkDailyRunEnabled();

  // Add newly eligible jobs, or re-schedule if config changed
  for (const { job, account } of eligible) {
    const existing = schedule.get(job.id);
    const resolvedTz = resolveJobTimezone(job.timezone);
    if (!existing) {
      // Nothing in memory means either a fresh process (an upgrade restart, say) or a job
      // that just became eligible. Re-arm the plan the last process left behind rather than
      // rebuilding it from the run history: a run that was days out has to stay days out.
      const stored = storedNextRun(job.id);
      if (
        stored &&
        stored.toMillis() > Date.now() &&
        planFitsWindow(job, stored, resolvedTz)
      ) {
        armRun(job, account, resolvedTz, stored.setZone(resolvedTz));
        continue;
      }
      // A plan for today that came and went is a run the day still owes; place it in what is
      // left of the day rather than letting the closed window push it to tomorrow.
      if (missedTodaysRun(job.id, resolvedTz)) {
        scheduleOne(job, account, 0, true);
        continue;
      }
      // No plan, or one whose moment has passed while the process was down -- fall back to
      // the interval, which puts a missed run at the next opportunity.
      const daysAhead = dailyCheckOn
        ? daysUntilNextRun(job.id, resolvedTz, job.runEveryDays ?? 1, job.runEveryDaysMax)
        : 0;
      scheduleOne(job, account, daysAhead);
    } else {
      // Compare resolved timezones so a default_timezone change reschedules
      // jobs that follow the default
      const scheduleChanged =
        existing.job.scheduleWindowStart !== job.scheduleWindowStart ||
        existing.job.scheduleWindowEnd !== job.scheduleWindowEnd ||
        existing.timezone !== resolvedTz ||
        existing.job.botUsername !== job.botUsername ||
        existing.job.accountId !== job.accountId ||
        existing.job.runEveryDays !== job.runEveryDays ||
        existing.job.runEveryDaysMax !== job.runEveryDaysMax;
      if (scheduleChanged) {
        const daysAhead = dailyCheckOn
          ? daysUntilNextRun(job.id, resolvedTz, job.runEveryDays ?? 1, job.runEveryDaysMax)
          : 0;
        scheduleOne(job, account, daysAhead);
      } else {
        // Keep the timer but update the stored snapshot so status reflects current settings
        schedule.set(job.id, { ...existing, job, account });
      }
    }
  }
}

export function refreshScheduler(): void {
  refreshJobs();
}

/** Deletes job logs older than the configured retention window. 0 keeps everything. */
export function purgeOldLogs(): void {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'log_retention_days'")
    .get() as { value: string } | undefined;
  const days = Number(row?.value ?? 0);
  if (!Number.isFinite(days) || days <= 0) return;

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  // Read the ids first: the screenshots of a purged run sit beside the database, and once
  // the row is gone nothing is left to say which folder was its.
  const going = db
    .prepare("SELECT id FROM job_logs WHERE ran_at < ? AND status != 'running'")
    .all(cutoff) as Array<{ id: number }>;
  const { changes } = db
    .prepare("DELETE FROM job_logs WHERE ran_at < ? AND status != 'running'")
    .run(cutoff);
  for (const { id } of going) deleteRunShots(id);
  if (changes > 0) {
    console.log(
      `[scheduler] Purged ${changes} job log(s) older than ${days} day(s)`,
    );
  }
}

// ── Bringing existing history up to date ──────────────────────────────────────
//
// Two things every log row needs that older rows do not have: its screenshots as files
// rather than inside the row, and its size recorded. Both are one-time work over the whole
// table, which on a real install means tens of thousands of rows and hundreds of megabytes
// of blob, so how it is done matters more than what it does:
//
//  - One forward pass ordered by id. The first version picked each row with
//    `WHERE detail LIKE '%data:image/%'`, which scans the table (and every blob in it) once
//    per row rewritten: measured at 508ms a row on a 20,000 row table, so hours of work
//    that never finished.
//  - In batches with the event loop given a turn in between. better-sqlite3 is synchronous,
//    so a long pass does not slow the panel down, it stops it dead.
//  - Resumable. The cursor is stored, so a restart carries on rather than starting again.
//  - The blob is left in the database unless it is actually needed: SQLite can say how long
//    it is and whether it holds an image without handing it over.

/** Rows per turn, and the pause between turns. Small enough that no turn is felt. */
const LOG_BACKFILL_BATCH = 25;
const LOG_BACKFILL_PAUSE_MS = 50;

const BACKFILL_DONE_KEY = "migration:job-logs-storage";
const BACKFILL_CURSOR_KEY = "migration:job-logs-storage-cursor";

function settingNumber(key: string): number | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row?.value == null) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

function setSetting(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

/** Whether any history is still waiting to be brought up to date. */
export function runLogBackfillPending(): boolean {
  try {
    if (settingNumber(BACKFILL_DONE_KEY) === 1) return false;
    // An install that finished the first version of this pass has nothing left to do
    const oldFlags = db
      .prepare(
        "SELECT COUNT(*) AS n FROM settings WHERE key IN ('migration:job-logs-images-to-files', 'migration:job-logs-detail-bytes')",
      )
      .get() as { n: number };
    if (oldFlags.n === 2) {
      setSetting(BACKFILL_DONE_KEY, "1");
      return false;
    }
    return true;
  } catch {
    return false; // no settings table (a test fixture): nothing to do
  }
}

export type BackfillProgress = {
  /** Rows looked at this turn. */
  processed: number;
  /** Rows whose images were moved out of the database. */
  moved: number;
  /** Rows whose size was recorded for the first time. */
  measured: number;
  done: boolean;
};

/**
 * One turn of the pass: brings up to `limit` rows up to date and moves the cursor. Returns
 * what it did, and whether the table is finished.
 */
export function backfillRunLogStorage(limit = LOG_BACKFILL_BATCH): BackfillProgress {
  const idle: BackfillProgress = { processed: 0, moved: 0, measured: 0, done: true };
  if (!runLogBackfillPending()) return idle;

  const after = settingNumber(BACKFILL_CURSOR_KEY) ?? 0;
  // What is needed about each row, without carrying the blob itself out of SQLite
  const rows = db
    .prepare(
      `SELECT id,
              LENGTH(COALESCE(detail, '')) AS len,
              instr(COALESCE(detail, ''), 'data:image/') AS inlineImage,
              instr(COALESCE(detail, ''), 'shot:') AS shotRef,
              detail_bytes AS bytes
       FROM job_logs
       WHERE id > ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(after, limit) as Array<{
    id: number;
    len: number;
    inlineImage: number;
    shotRef: number;
    bytes: number | null;
  }>;

  if (!rows.length) {
    setSetting(BACKFILL_DONE_KEY, "1");
    console.log("[scheduler] Run log history is up to date");
    return idle;
  }

  const readDetail = db.prepare("SELECT detail FROM job_logs WHERE id = ?");
  const saveBoth = db.prepare("UPDATE job_logs SET detail = ?, detail_bytes = ? WHERE id = ?");
  const saveSize = db.prepare("UPDATE job_logs SET detail_bytes = ? WHERE id = ?");

  let moved = 0;
  let measured = 0;
  for (const row of rows) {
    try {
      if (row.inlineImage > 0) {
        const stored = (readDetail.get(row.id) as { detail: string | null }).detail;
        if (!stored) continue;
        const parsed = JSON.parse(stored);
        boundRunImages(parsed);
        externaliseRunImages(row.id, parsed);
        const next = JSON.stringify(parsed);
        saveBoth.run(next, next.length + runShotsBytes(row.id), row.id);
        moved++;
      } else if (row.bytes == null) {
        // Only a row that points at a file has a folder worth measuring
        saveSize.run(row.len + (row.shotRef > 0 ? runShotsBytes(row.id) : 0), row.id);
        measured++;
      }
    } catch (e) {
      console.warn(`[scheduler] run ${row.id} log left as it was:`, e);
    }
  }

  setSetting(BACKFILL_CURSOR_KEY, String(rows[rows.length - 1].id));
  return { processed: rows.length, moved, measured, done: false };
}

/**
 * Works through the history in the background, a batch at a time. Started once at boot;
 * ends when the table is finished, and picks up where it left off after a restart.
 */
export function startRunLogBackfill(): void {
  if (!runLogBackfillPending()) return;
  let moved = 0;
  let measured = 0;
  let processed = 0;

  const turn = () => {
    let progress: BackfillProgress;
    try {
      progress = backfillRunLogStorage();
    } catch (e) {
      console.warn("[scheduler] run log history pass stopped:", e);
      return;
    }
    moved += progress.moved;
    measured += progress.measured;
    processed += progress.processed;
    if (progress.done) {
      if (moved || measured)
        console.log(
          `[scheduler] Run log history brought up to date: ${processed} row(s), ${moved} with images moved out of the database, ${measured} measured`,
        );
      return;
    }
    setTimeout(turn, LOG_BACKFILL_PAUSE_MS).unref?.();
  };

  console.log("[scheduler] Bringing run log history up to date in the background");
  setTimeout(turn, LOG_BACKFILL_PAUSE_MS).unref?.();
}

/**
 * Drops screenshot folders no row points at any more, and gives SQLite's freed pages back
 * to the file system. A purge only marks pages reusable, so without this the database keeps
 * whatever size its largest day of logs took it to.
 */
export function sweepLogStorage(): void {
  const stillLogged = db.prepare("SELECT 1 FROM job_logs WHERE id = ?");
  try {
    const removed = pruneOrphanRunShots((logId) => stillLogged.get(logId) !== undefined);
    if (removed > 0) console.log(`[scheduler] Removed screenshots of ${removed} gone run(s)`);
  } catch (e) {
    console.warn("[scheduler] screenshot sweep failed:", e);
  }
  try {
    // A vacuum rewrites the whole file and blocks everything else while it does, so it is
    // worth it only when there is real space to get back: on a large database that has not
    // been purged, a daily rewrite is all cost and no gain. 8MB of free pages, or a tenth
    // of the file, is the point where it pays.
    const before = pageCount();
    const free = freePageCount();
    const worthIt = free * pageSize() > 8_388_608 || free > before / 10;
    if (!worthIt) return;

    db.exec("VACUUM");
    // In WAL mode the rewrite lands in the log, not the database file: without a truncating
    // checkpoint the pages are free but the disk is not, which is the whole point of this.
    db.pragma("wal_checkpoint(TRUNCATE)");
    const after = pageCount();
    if (before - after > 256)
      console.log(
        `[scheduler] Database compacted: ${Math.round(((before - after) * pageSize()) / 1_048_576)}MB returned`,
      );
  } catch (e) {
    // A vacuum needs room for a copy of the database and cannot run inside a transaction
    console.warn("[scheduler] database not compacted:", e);
  }
}

function pageCount(): number {
  return Number((db.pragma("page_count", { simple: true }) as number) ?? 0);
}

function pageSize(): number {
  return Number((db.pragma("page_size", { simple: true }) as number) ?? 4096);
}

function freePageCount(): number {
  return Number((db.pragma("freelist_count", { simple: true }) as number) ?? 0);
}

/**
 * Mark any job_logs still in 'running' state as failed. On a fresh process
 * start nothing is actually running, so a leftover 'running' row means the
 * previous process was killed mid-run (e.g. during an upgrade), leaving the
 * log stuck and un-stoppable. (issue #18)
 */
export function reconcileOrphanedRuns(): void {
  const { changes } = db
    .prepare(
      "UPDATE job_logs SET status = 'failed', message = 'Interrupted by server restart' WHERE status = 'running'",
    )
    .run();
  if (changes > 0) {
    console.log(`[scheduler] Marked ${changes} interrupted run(s) as failed`);
  }
}

export function startScheduler(): void {
  console.log("[scheduler] Starting");
  reconcileOrphanedRuns();
  refreshJobs();
  // Re-check every 5 minutes to pick up new/changed jobs
  setInterval(refreshJobs, 5 * 60 * 1000);
  purgeOldLogs();
  // Retention sweep is cheap, so hourly keeps the table tidy without load
  setInterval(purgeOldLogs, 60 * 60 * 1000);
  // Reclaiming disk is not: a vacuum rewrites the file, so it waits for a quiet moment
  // after boot and then runs daily.
  // The history pass runs itself in the background; the sweep waits for a quiet moment so
  // it is not competing with it or with the jobs a fresh boot arms.
  startRunLogBackfill();
  setTimeout(sweepLogStorage, 10 * 60 * 1000);
  setInterval(sweepLogStorage, 24 * 60 * 60 * 1000);
}

export function getSchedulerStatus(): Array<{
  jobId: number;
  jobName: string;
  jobType: string;
  nextRun: string;
  icon: string | null;
}> {
  return Array.from(schedule.values()).map(({ job, nextRun }) => ({
    jobId: job.id,
    jobName: job.name,
    jobType: job.jobType,
    nextRun: nextRun.toISOString(),
    // Carried so the schedule chips can show the job's own icon rather than its type's
    icon: job.icon ?? null,
  }));
}

/**
 * Drops a job's pending run and arms the one after it, which is how an operator calls off a
 * run they can see coming without disabling the job. The job keeps its schedule; only this
 * occurrence is given up, so the list shows it again on its next eligible day.
 */
export function skipNextRun(jobId: number): { ok: boolean; nextRun?: string } {
  const entry = schedule.get(jobId);
  if (!entry) return { ok: false };

  // Counted from the pending run's own day, not from today: that run may already be days out
  // (its window has passed today), and a day counted from today would land on or before it --
  // rescheduling the very run being called off, sometimes to an earlier minute.
  const pendingDay = DateTime.fromJSDate(entry.nextRun)
    .setZone(entry.timezone)
    .startOf("day");
  const today = DateTime.now().setZone(entry.timezone).startOf("day");
  const daysUntilPending = Math.max(0, Math.round(pendingDay.diff(today, "days").days));

  // Past that day, the next opportunity is one interval on -- one day for a daily job
  const interval = checkDailyRunEnabled()
    ? Math.max(
        1,
        resolveRunEveryDays(jobId, entry.job.runEveryDays ?? 1, entry.job.runEveryDaysMax),
      )
    : 1;
  const daysAhead = daysUntilPending + interval;

  scheduleOne(entry.job, entry.account, daysAhead);
  const nextRun = schedule.get(jobId)?.nextRun.toISOString();
  console.log(`[scheduler] "${entry.job.name}" run skipped by operator; next run: ${nextRun}`);
  return { ok: true, nextRun };
}
