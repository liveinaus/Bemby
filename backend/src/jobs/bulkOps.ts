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
  registerPasskeyForAccount,
  terminateOtherSessionsForAccount,
  updateTwoFaForAccount,
  verifyStoredPasskeyForAccount,
} from "./accountOps";
import { describePrivacyResult } from "../tg/privacy";
import { startManualJobRun } from "./manualRun";
import { cancelJob } from "./cancellation";
import {
  startBulkTask,
  TERMINATED,
  type BulkTaskContext,
  type BulkTaskEntry,
  type StartBulkTaskResult,
} from "./bulkTasks";

// Wires each long bulk action to the background task runner. Everything the UI
// used to loop over in the browser starts here instead, so the page can be
// closed while the work continues.

const DEFAULT_TG_GAP_SECONDS = 30;
const DEFAULT_FETCH_GAP_SECONDS = 5;
const DEFAULT_JOB_GAP_SECONDS = 70;

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

function jobEntries(ids: number[]): BulkTaskEntry[] {
  const unique = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!unique.length) return [];
  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, name FROM jobs WHERE id IN (${placeholders}) ORDER BY id`,
    )
    .all(...unique) as Array<{ id: number; name: string }>;
  return rows.map((r) => ({ refId: r.id, refName: r.name }));
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
        data: { spamStatus: result.spamStatus },
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
  gmail: string;
  appPassword: string;
  tag: string;
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
  const { gmail, appPassword, tag } = options;
  return startBulkTask({
    kind: "login-email",
    entries,
    gapSeconds: gapSeconds ?? DEFAULT_TG_GAP_SECONDS,
    handler: async (item) => {
      const { email } = await changeLoginEmailForAccount(item.refId, {
        gmail,
        appPassword,
        tag,
      });
      return { message: email, data: { email } };
    },
  });
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

/** Waits for a manual run, aborting it if the task is terminated meanwhile. */
async function awaitRun(
  logId: number,
  completion: Promise<void>,
  ctx: BulkTaskContext,
): Promise<void> {
  let settled = false;
  void completion.finally(() => {
    settled = true;
  });
  while (!settled) {
    if (ctx.cancelled()) {
      cancelJob(logId);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await completion;
}

export function startBulkJobRuns(
  jobIds: number[],
  gapSeconds?: number,
): StartBulkTaskResult {
  const entries = jobEntries(jobIds);
  if (!entries.length) return { ok: false, error: "No jobs in the selection" };
  return startBulkTask({
    kind: "run-jobs",
    entries,
    gapSeconds: gapSeconds ?? DEFAULT_JOB_GAP_SECONDS,
    handler: async (item, ctx) => {
      const started = startManualJobRun(item.refId);
      if (!started.ok) throw new Error(started.error);
      ctx.progress("Running");
      await awaitRun(started.logId, started.completion, ctx);
      const log = db
        .prepare("SELECT status, message FROM job_logs WHERE id = ?")
        .get(started.logId) as
        | { status: string; message: string | null }
        | undefined;
      if (log?.status === "failed") {
        // A run aborted by the terminate button is not the job's own failure
        if (ctx.cancelled()) throw new Error(TERMINATED);
        throw new Error(log.message || "Job run failed");
      }
      return {
        message: log?.message ?? "Completed",
        data: { logId: started.logId, status: log?.status ?? "unknown" },
      };
    },
  });
}
