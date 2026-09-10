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

async function acquireRunSlot(): Promise<void> {
  if (runningJobs < MAX_CONCURRENT_JOBS) {
    runningJobs++;
    return;
  }
  // Slot is handed over directly by releaseRunSlot, so no counter change here
  await new Promise<void>((resolve) => waitingJobs.push(resolve));
}

function releaseRunSlot(): void {
  const next = waitingJobs.shift();
  if (next) next();
  else runningJobs--;
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
  await acquireRunSlot();
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

    await runJob(job, account, detailLogs, signal);
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
    `[scheduler] "${job.name}" next run: ${nextRun.toISO()} (in ${Math.round(delayMs / 60_000)} min)`,
  );
}

function scheduleOne(job: Job, account: TgAccount | null, daysAhead = 0): void {
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
    { occupied, gapMinutes: getScheduleGapMinutes() },
  );
  armRun(job, account, timezone, nextRun);
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

/**
 * Moves the images in run history already stored inside the rows out to files, once.
 *
 * Without this an install that has been running a while keeps whatever its logs grew to:
 * one measured database was 531MB, 500MB of it images in 836 rows, and nothing would have
 * shrunk it short of the operator deleting their history. Done a row at a time so the pass
 * costs one row's worth of memory rather than the table's, and after the first pass the
 * flag makes it free.
 */
export function migrateRunImagesToFiles(): void {
  runOnce("job-logs-images-to-files", () => {
    const pick = db.prepare(
      "SELECT id, detail FROM job_logs WHERE detail LIKE '%data:image/%' ORDER BY id LIMIT 1",
    );
    const save = db.prepare("UPDATE job_logs SET detail = ? WHERE id = ?");
    let moved = 0;
    let freed = 0;
    // One at a time, re-querying rather than paging: each row is rewritten so it drops out
    // of the match, and a row that somehow cannot be is skipped by id below.
    const skip = new Set<number>();
    for (;;) {
      const row = pick.get() as { id: number; detail: string } | undefined;
      if (!row || skip.has(row.id)) break;
      try {
        const parsed = JSON.parse(row.detail);
        boundRunImages(parsed);
        externaliseRunImages(row.id, parsed);
        const next = JSON.stringify(parsed);
        freed += row.detail.length - next.length;
        save.run(next, row.id);
        moved++;
      } catch (e) {
        console.warn(`[scheduler] run ${row.id} log left as it was:`, e);
        skip.add(row.id);
      }
    }
    if (moved)
      console.log(
        `[scheduler] Moved the images of ${moved} run log(s) out of the database (${Math.round(freed / 1_048_576)}MB)`,
      );
  });

  // The size the log list shows. Recorded on every run from here on, so this is only for
  // the history that pre-dates the column.
  runOnce("job-logs-detail-bytes", () => {
    const rows = db
      .prepare("SELECT id, LENGTH(COALESCE(detail, '')) AS len FROM job_logs WHERE detail_bytes IS NULL")
      .all() as Array<{ id: number; len: number }>;
    const save = db.prepare("UPDATE job_logs SET detail_bytes = ? WHERE id = ?");
    const record = db.transaction((list: Array<{ id: number; len: number }>) => {
      for (const row of list) save.run(row.len + runShotsBytes(row.id), row.id);
    });
    record(rows);
    if (rows.length) console.log(`[scheduler] Measured ${rows.length} run log(s)`);
  });
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
    const before = pageCount();
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
  setTimeout(() => {
    migrateRunImagesToFiles();
    sweepLogStorage();
  }, 5 * 60 * 1000);
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
