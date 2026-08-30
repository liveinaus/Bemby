import { db } from "../db/database";
import type { Job } from "../types";

// What every successful run has to record, wherever it was started from: the durable
// success stamp, and the switch-off a "one time job" asks for.

/**
 * Stamps `last_success_at` and, for a one-time job, switches it off.
 *
 * The stamp only moves forward so a slow run finishing after a later one cannot rewind it.
 * Both writes are isolated: a failure here must not demote an otherwise successful run.
 *
 * @returns true when the job was switched off, so the caller can rebuild the schedule.
 */
export function recordJobSuccess(job: Job, ranAt: string): boolean {
  try {
    db.prepare(
      `UPDATE jobs SET last_success_at = ?
       WHERE id = ? AND (last_success_at IS NULL OR last_success_at < ?)`,
    ).run(ranAt, job.id, ranAt);
  } catch (e) {
    console.warn(`[jobs] "${job.name}" last_success_at stamp failed:`, e);
  }

  if (!job.oneTime) return false;
  try {
    const { changes } = db
      .prepare("UPDATE jobs SET enabled = 0 WHERE id = ? AND enabled = 1")
      .run(job.id);
    if (changes) console.log(`[jobs] "${job.name}" disabled: one time job succeeded`);
    return changes > 0;
  } catch (e) {
    console.warn(`[jobs] "${job.name}" one-time disable failed:`, e);
    return false;
  }
}
