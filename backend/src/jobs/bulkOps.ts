import { db } from "../db/database";
import {
  accountHasPasskeyFlag,
  appendAccountNotes,
  changeLoginEmailForAccount,
  checkSpamForAccount,
  cleanTelegramAccount,
  deletePasskeyForAccount,
  fetchAttributesForAccount,
  hardenPrivacyForAccount,
  listPasskeysForAccount,
  loadAccount,
  registerPasskeyForAccount,
  resolveAccountExit,
  terminateOtherSessionsForAccount,
  updateTwoFaForAccount,
  verifyStoredPasskeyForAccount,
} from "./accountOps";
import { describePrivacyResult } from "../tg/privacy";
import { startManualJobRun } from "./manualRun";
import { cancelJob } from "./cancellation";
import {
  queuedRefIds,
  runningTasksOfKind,
  scopeConflict,
  startBulkTask,
  TERMINATED,
  type BulkTaskContext,
  type BulkTaskEntry,
  type StartBulkTaskResult,
} from "./bulkTasks";
import { acquireBulkRunSlot } from "./runSlots";

// Wires each long bulk action to the background task runner. Everything the UI
// used to loop over in the browser starts here instead, so the page can be
// closed while the work continues.

const DEFAULT_TG_GAP_SECONDS = 30;
const DEFAULT_FETCH_GAP_SECONDS = 5;
const DEFAULT_JOB_GAP_SECONDS = 70;
/**
 * Ceiling on one run inside a batch. A run that stalls -- a dead proxy, a site that never
 * answers, a browser call the deadline never reaches -- used to hold the whole queue until
 * someone terminated it by hand. Past this the run is cancelled and the batch moves on.
 * Set to 0 to wait indefinitely.
 */
const DEFAULT_JOB_MAX_RUN_SECONDS = 1800;
/**
 * How many job queues may run at once. Each covers its own templates, so this only
 * stops an operator opening so many that the list stops being readable -- what caps
 * the actual load is the run slots the items take.
 */
const MAX_RUN_JOB_QUEUES = 5;
/** Grace given to a cancelled run to unwind before the batch gives up on it entirely. */
const CANCEL_GRACE_MS = 30_000;

/** Selected accounts, in list order, restricted to ones with a live session. */
function authenticatedAccountEntries(ids: number[]): BulkTaskEntry[] {
  const unique = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!unique.length) return [];
  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, name FROM tg_accounts
       WHERE id IN (${placeholders}) AND auth_status = 'authenticated'
       ORDER BY sort_order, id`,
    )
    .all(...unique) as Array<{ id: number; name: string }>;
  return rows.map((r) => ({ refId: r.id, refName: r.name }));
}

type JobSelectionRow = {
  id: number;
  name: string;
  job_type: string;
  template_id: number | null;
  template_name: string | null;
};

function jobSelection(ids: number[]): JobSelectionRow[] {
  const unique = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!unique.length) return [];
  const placeholders = unique.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT j.id, j.name, j.job_type, j.template_id, t.name AS template_name
         FROM jobs j LEFT JOIN job_templates t ON t.id = j.template_id
        WHERE j.id IN (${placeholders})
        ORDER BY j.id`,
    )
    .all(...unique) as JobSelectionRow[];
}

/**
 * What a job's run queue competes for: its template, or its type when it has none
 * (a bot or URL job answers to no template). Selections covering the same set of
 * groups share a queue; anything else runs alongside.
 */
function jobGroupKey(row: JobSelectionRow): string {
  return row.template_id ? `t${row.template_id}` : `y${row.job_type}`;
}

function jobGroupLabel(row: JobSelectionRow): string {
  return row.template_name || row.job_type;
}

/** The running queue that owes this job a run, so the panel can point at it. */
function holderOfJob(jobId: number) {
  return runningTasksOfKind("run-jobs").find((task) =>
    task.items.some(
      (item) =>
        item.refId === jobId &&
        (item.status === "pending" ||
          item.status === "waiting" ||
          item.status === "working"),
    ),
  );
}

const MAX_LABEL_GROUPS = 3;

/** Scope key and readable label for a selection, keyed on template where there is one. */
function jobScope(rows: JobSelectionRow[]): { scope: string; label: string } {
  const groups = new Map<string, string>();
  for (const row of rows) groups.set(jobGroupKey(row), jobGroupLabel(row));
  const keys = [...groups.keys()].sort();
  const labels = keys.map((key) => groups.get(key)!);
  const shown = labels.slice(0, MAX_LABEL_GROUPS).join(" + ");
  return {
    scope: keys.join("+"),
    label:
      labels.length > MAX_LABEL_GROUPS
        ? `${shown} +${labels.length - MAX_LABEL_GROUPS}`
        : shown,
  };
}

const NO_ACCOUNTS: StartBulkTaskResult = {
  ok: false,
  error: "No authenticated accounts in the selection",
};

/** Null when the selection holds nothing this task could act on. */
function accountTargets(ids: number[]): BulkTaskEntry[] | null {
  const entries = authenticatedAccountEntries(ids);
  return entries.length ? entries : null;
}

export function startBulkSpamCheck(
  ids: number[],
  gapSeconds?: number,
): StartBulkTaskResult {
  const entries = accountTargets(ids);
  if (!entries) return NO_ACCOUNTS;
  return startBulkTask({
    kind: "spam-check",
    entries,
    gapSeconds: gapSeconds ?? DEFAULT_TG_GAP_SECONDS,
    handler: async (item) => {
      const result = await checkSpamForAccount(item.refId);
      return {
        message: result.rawMessage,
        data: { spamStatus: result.spamStatus, buttons: result.buttons, source: result.source },
      };
    },
  });
}

export function startBulkFetchAttributes(
  ids: number[],
  gapSeconds?: number,
): StartBulkTaskResult {
  const entries = accountTargets(ids);
  if (!entries) return NO_ACCOUNTS;
  return startBulkTask({
    kind: "fetch-attributes",
    entries,
    gapSeconds: gapSeconds ?? DEFAULT_FETCH_GAP_SECONDS,
    handler: async (item) => {
      const { warnings, authExpired } = await fetchAttributesForAccount(
        item.refId,
      );
      return {
        message: warnings.join("; "),
        data: { warnings, authExpired },
      };
    },
  });
}

export type BulkLoginEmailOptions = {
  /** Where the address comes from; blank is Gmail, as it was before the pool existed. */
  source?: "gmail" | "msapi";
  gmail?: string;
  appPassword?: string;
  tag?: string;
  /** Pool type for the msapi source; blank uses the configured default. */
  poolType?: string;
};

export function startBulkLoginEmail(
  ids: number[],
  options: BulkLoginEmailOptions,
  gapSeconds?: number,
): StartBulkTaskResult {
  const entries = accountTargets(ids);
  if (!entries) return NO_ACCOUNTS;
  // Kept in the closure only: the Gmail app password must never reach the task
  // list the panel polls.
  const { source, gmail, appPassword, tag, poolType } = options;
  const opts =
    source === "msapi"
      ? ({ source: "msapi", poolType } as const)
      : ({
          source: "gmail",
          gmail: gmail ?? "",
          appPassword: appPassword ?? "",
          tag: tag ?? "",
        } as const);
  warnSharedExits(entries);
  return startBulkTask({
    kind: "login-email",
    entries,
    gapSeconds: gapSeconds ?? DEFAULT_TG_GAP_SECONDS,
    handler: async (item) => {
      const { email, exit } = await changeLoginEmailForAccount(item.refId, opts);
      return { message: email, data: { email, exit } };
    },
  });
}

/**
 * Telegram will accept SendVerifyEmailCode from one address for a while and then simply stop
 * delivering the mail, which reads from here as "the first account worked and the rest timed
 * out waiting for a code". Accounts that share an exit -- or have none, so they all leave by
 * the server's own address -- are the usual cause, so say so before the run starts.
 */
function warnSharedExits(entries: BulkTaskEntry[]): void {
  const byExit = new Map<string, number>();
  for (const entry of entries) {
    let exit: string;
    try {
      const account = loadAccount(entry.refId);
      exit = account ? resolveAccountExit(account).label : "unknown";
    } catch {
      // A broken proxy reference fails the item itself with its own message
      continue;
    }
    byExit.set(exit, (byExit.get(exit) ?? 0) + 1);
  }
  const shared = [...byExit].filter(([, count]) => count > 1);
  if (!shared.length) return;
  console.warn(
    `[bulkOps] login-email run shares exits across accounts: ${shared
      .map(([exit, count]) => `${exit} x${count}`)
      .join(", ")}. Telegram stops delivering login-email codes sent from one address in quick succession.`,
  );
}

export type BulkCredentialOptions = {
  currentPassword?: string;
  newPassword: string;
  removeDevices?: boolean;
  removePasskeys?: boolean;
  notesAppend?: string;
};

export function startBulkCredentials(
  ids: number[],
  options: BulkCredentialOptions,
  gapSeconds?: number,
): StartBulkTaskResult {
  if (!options?.newPassword) {
    return { ok: false, error: "newPassword is required" };
  }
  const entries = accountTargets(ids);
  if (!entries) return NO_ACCOUNTS;
  const {
    currentPassword,
    newPassword,
    removeDevices,
    removePasskeys,
    notesAppend,
  } = options;
  const append = (notesAppend ?? "").trim();

  return startBulkTask({
    kind: "credentials",
    entries,
    gapSeconds: gapSeconds ?? DEFAULT_TG_GAP_SECONDS,
    handler: async (item, ctx) => {
      const data: Record<string, unknown> = {};
      ctx.progress("Changing 2FA password");
      await updateTwoFaForAccount(item.refId, {
        currentPassword,
        newPassword,
      });
      data.twoFaChanged = true;

      const hadPasskey = accountHasPasskeyFlag(item.refId);
      if (removeDevices) {
        ctx.progress("Removing other devices");
        await terminateOtherSessionsForAccount(item.refId);
        data.devicesRemoved = true;
      }
      if (removePasskeys || hadPasskey) {
        // storedIds is pruned to passkeys that still exist on Telegram.
        ctx.progress("Reviewing passkeys");
        const { passkeys, storedIds } = await listPasskeysForAccount(item.refId);
        if (removePasskeys) {
          // Keep passkeys Bemby manages; remove all others.
          const toRemove = passkeys.filter((pk) => !storedIds.includes(pk.id));
          for (const pk of toRemove) {
            await deletePasskeyForAccount(item.refId, pk.id);
          }
          data.passkeysRemoved = toRemove.length;
        }
        // A 2FA password change drops passkeys on Telegram's side; re-add Bemby's
        // so it survives the credential change.
        if (hadPasskey && storedIds.length === 0) {
          ctx.progress("Re-adding Bemby passkey");
          await registerPasskeyForAccount(item.refId);
          data.passkeyReadded = true;
        }
      }
      if (append) {
        appendAccountNotes(item.refId, append);
        data.notesUpdated = true;
      }
      return { data };
    },
  });
}

export function startBulkPasskey(
  ids: number[],
  gapSeconds?: number,
): StartBulkTaskResult {
  const entries = accountTargets(ids);
  if (!entries) return NO_ACCOUNTS;
  return startBulkTask({
    kind: "passkey",
    entries,
    gapSeconds: gapSeconds ?? DEFAULT_TG_GAP_SECONDS,
    handler: async (item) => {
      const { storedIds } = await listPasskeysForAccount(item.refId);
      if (storedIds.length) {
        // Already has a Bemby-managed passkey -- do not add another; verify it.
        const verification = await verifyStoredPasskeyForAccount(
          item.refId,
          storedIds[0],
        );
        if (!verification.ok) throw new Error("Existing passkey is not usable");
        return { data: { action: "skippedValid" } };
      }
      await registerPasskeyForAccount(item.refId);
      return { data: { action: "added" } };
    },
  });
}

/**
 * Hides everything the account can hide. A settings change rather than a message, so the gap
 * between accounts is the shorter one: the calls are cheap and nothing is being sent anywhere.
 */
export function startBulkPrivacy(
  ids: number[],
  gapSeconds?: number,
): StartBulkTaskResult {
  const entries = accountTargets(ids);
  if (!entries) return NO_ACCOUNTS;
  return startBulkTask({
    kind: "privacy",
    entries,
    gapSeconds: gapSeconds ?? DEFAULT_FETCH_GAP_SECONDS,
    handler: async (item) => {
      const result = await hardenPrivacyForAccount(item.refId);
      return { message: describePrivacyResult(result), data: { ...result } };
    },
  });
}

export function startBulkClean(
  ids: number[],
  gapSeconds?: number,
): StartBulkTaskResult {
  const entries = accountTargets(ids);
  if (!entries) return NO_ACCOUNTS;
  return startBulkTask({
    kind: "clean",
    entries,
    gapSeconds: gapSeconds ?? DEFAULT_TG_GAP_SECONDS,
    handler: async (item) => {
      const result = await cleanTelegramAccount(item.refId);
      return { data: { ...result } };
    },
  });
}

/**
 * Waits for a manual run, aborting it if the task is terminated meanwhile or if it
 * outlives `maxRunMs`. Returns true when the run was stopped by that ceiling, which the
 * caller reports as this item's failure rather than the job's own.
 */
async function awaitRun(
  logId: number,
  completion: Promise<void>,
  ctx: BulkTaskContext,
  maxRunMs = 0,
): Promise<{ timedOut: boolean }> {
  let settled = false;
  void completion.finally(() => {
    settled = true;
  });
  const deadline = maxRunMs > 0 ? Date.now() + maxRunMs : 0;
  let timedOut = false;
  while (!settled) {
    if (ctx.cancelled()) {
      cancelJob(logId);
      break;
    }
    if (deadline && Date.now() >= deadline) {
      timedOut = true;
      cancelJob(logId);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  // Cancelling asks the run to stop; a wedged one may not manage it, and waiting on that
  // is the stall this ceiling exists to end. Give it a moment to unwind, then move on.
  if (timedOut) {
    await Promise.race([
      completion.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, CANCEL_GRACE_MS)),
    ]);
    return { timedOut };
  }
  await completion;
  return { timedOut };
}

export function startBulkJobRuns(
  jobIds: number[],
  gapSeconds?: number,
  maxRunSeconds?: number,
): StartBulkTaskResult {
  const rows = jobSelection(jobIds);
  if (!rows.length) return { ok: false, error: "No jobs in the selection" };

  // Screened before the overlap check below, so re-running a template that is already
  // going says so -- and names its queue -- instead of listing the jobs inside it.
  const { scope, label } = jobScope(rows);
  const busy = scopeConflict("run-jobs", scope);
  if (busy) return busy;

  // A job queued elsewhere would otherwise be started twice at once, by two queues
  // that each believe they own it.
  const queued = queuedRefIds("run-jobs");
  const clash = rows.filter((row) => queued.has(row.id));
  if (clash.length) {
    const names = clash.slice(0, 3).map((row) => row.name).join(", ");
    const rest = clash.length > 3 ? ` and ${clash.length - 3} more` : "";
    return {
      ok: false,
      error: `Already queued in another background run: ${names}${rest}`,
      conflictTaskId: holderOfJob(clash[0].id)?.id,
    };
  }

  const entries: BulkTaskEntry[] = rows.map((row) => ({
    refId: row.id,
    refName: row.name,
  }));
  const maxRunMs =
    (Number.isFinite(maxRunSeconds) && (maxRunSeconds as number) >= 0
      ? (maxRunSeconds as number)
      : DEFAULT_JOB_MAX_RUN_SECONDS) * 1000;
  return startBulkTask({
    kind: "run-jobs",
    entries,
    scope,
    label,
    maxRunning: MAX_RUN_JOB_QUEUES,
    gapSeconds: gapSeconds ?? DEFAULT_JOB_GAP_SECONDS,
    handler: async (item, ctx) => {
      // Queues no longer take turns, so the runs inside them do: this is what keeps
      // several template queues from opening a browser each at the same moment.
      ctx.progress("Waiting for a run slot");
      const slot = await acquireBulkRunSlot(ctx.cancelled);
      if (!slot) throw new Error(TERMINATED);
      try {
        return await runOneJob(item.refId, ctx, maxRunMs);
      } finally {
        slot.release();
      }
    },
  });
}

async function runOneJob(
  jobId: number,
  ctx: BulkTaskContext,
  maxRunMs: number,
): Promise<{ message: string; data: Record<string, unknown> }> {
  const started = startManualJobRun(jobId);
  if (!started.ok) throw new Error(started.error);
  ctx.progress("Running");
  const { timedOut } = await awaitRun(
    started.logId,
    started.completion,
    ctx,
    maxRunMs,
  );
  if (timedOut) {
    const message = `Run passed the ${Math.round(maxRunMs / 1000)}s limit and was terminated`;
    // A run that did not unwind inside the grace leaves its row open; settle it here so
    // the log does not read as still running with nothing behind it.
    db.prepare(
      "UPDATE job_logs SET status = 'failed', message = ? WHERE id = ? AND status = 'running'",
    ).run(message, started.logId);
    throw new Error(message);
  }
  const log = db
    .prepare("SELECT status, message FROM job_logs WHERE id = ?")
    .get(started.logId) as { status: string; message: string | null } | undefined;
  if (log?.status === "failed") {
    // A run aborted by the terminate button is not the job's own failure
    if (ctx.cancelled()) throw new Error(TERMINATED);
    throw new Error(log.message || "Job run failed");
  }
  return {
    message: log?.message ?? "Completed",
    data: { logId: started.logId, status: log?.status ?? "unknown" },
  };
}
