import { db } from "../db/database";
import { decryptAccountRow } from "../db/secretColumns";
import { runJob, type JobDetailLog } from "./runner";
import { collectRunWarnings, completedMessage } from "./runWarnings";
import {
  notifyJobEvent,
  buildFailureMessage,
  buildSuccessMessage,
} from "./notify";
import {
  registerJob,
  unregisterJob,
  registerLiveDetail,
  clearLiveDetail,
} from "./cancellation";
import { rowToAccount, rowToJob, type JobAccountRow, type JobRow } from "./jobRows";
import type { TgAccount } from "../types";

// Manual ("Run now") job execution, shared by the trigger route and the
// background bulk job runner. The route answers as soon as the log row exists;
// `completion` lets a caller wait for the run to actually finish.

export type ManualRunStart =
  | { ok: true; logId: number; completion: Promise<void> }
  | { ok: false; status: number; error: string };

export function startManualJobRun(jobId: number | string): ManualRunStart {
  const jobRow = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as
    | JobRow
    | undefined;
  if (!jobRow) return { ok: false, status: 404, error: "Not found" };

  const job = rowToJob(jobRow);
  let account: TgAccount | null = null;

  if (
    job.jobType === "checkin" ||
    job.jobType === "custom" ||
    job.jobType === "autoreg"
  ) {
    const accountRow = db
      .prepare("SELECT * FROM tg_accounts WHERE id = ?")
      .get(jobRow.account_id) as JobAccountRow | undefined;
    if (accountRow) decryptAccountRow(accountRow);
    if (!accountRow?.session_string) {
      return { ok: false, status: 400, error: "Account is not authenticated" };
    }
    account = rowToAccount(accountRow);
    if (!account.apiId || !account.apiHash) {
      return {
        ok: false,
        status: 400,
        error:
          "No API credentials available for this account. Add credentials to the account or configure global defaults in Settings.",
      };
    }
  } else if (job.accountId) {
    // Optional linked account (e.g. embywatch) -- used for notifications only; don't block if not authenticated
    const accountRow = db
      .prepare("SELECT * FROM tg_accounts WHERE id = ?")
      .get(job.accountId) as JobAccountRow | undefined;
    if (accountRow) decryptAccountRow(accountRow);
    if (accountRow?.session_string) {
      account = rowToAccount(accountRow);
    }
  }

  const ranAt = new Date().toISOString();
  const logResult = db
    .prepare(
      "INSERT INTO job_logs (job_id, ran_at, status, message, source) VALUES (?, ?, 'running', 'Manual run', 'manual')",
    )
    .run(job.id, ranAt);
  const logId = Number(logResult.lastInsertRowid);

  const detailLogs: JobDetailLog[] = [];
  const signal = registerJob(logId);
  registerLiveDetail(logId, detailLogs);
  const completion = runJob(job, account, detailLogs, signal)
    .then(() => {
      const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
      const warnings = collectRunWarnings(job.jobType, detailLogs);
      // Only while the row is still open: a cancel that gave up waiting has already
      // settled it, and that verdict is the one the user was shown
      db.prepare(
        "UPDATE job_logs SET status = 'success', message = ?, detail = ? WHERE id = ? AND status = 'running'",
      ).run(completedMessage(warnings), detail, logId);
      // Durable stamp; job_logs is pruned by log_retention_days. Only moves
      // forward so a slow run finishing after a later one can't rewind it.
      // Isolated: a failure here must not demote an otherwise successful run.
      try {
        db.prepare(
          `UPDATE jobs SET last_success_at = ?
           WHERE id = ? AND (last_success_at IS NULL OR last_success_at < ?)`,
        ).run(ranAt, job.id, ranAt);
      } catch (e) {
        console.warn(`[jobs] "${job.name}" last_success_at stamp failed:`, e);
      }
      void notifyJobEvent(
        "success",
        buildSuccessMessage(job.name, job.jobType),
        account,
      );
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const isCancelled = message === "Job cancelled";
      const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
      db.prepare(
        "UPDATE job_logs SET status = 'failed', message = ?, detail = ? WHERE id = ? AND status = 'running'",
      ).run(isCancelled ? "Cancelled" : message, detail, logId);
      if (!isCancelled) {
        void notifyJobEvent(
          "failed",
          buildFailureMessage(job.name, job.jobType, message),
          account,
        );
      }
    })
    .finally(() => {
      unregisterJob(logId);
      clearLiveDetail(logId);
    });

  return { ok: true, logId, completion };
}
