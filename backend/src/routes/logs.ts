import { Router } from 'express';
import { db } from '../db/database';
import { cancelJob, isJobRunning, getLiveDetail } from '../jobs/cancellation';
import { parsePaging, textParam, escapeLike, bulkIds } from './list-query';

const router = Router();

/** Parses a positive integer query param, clamped to [1, max]. */
function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`
    SELECT l.id, l.job_id, l.ran_at, l.status, l.message, l.detail,
           j.name AS job_name, j.job_type,
           a.name AS account_name
    FROM job_logs l
    LEFT JOIN jobs j ON l.job_id = j.id
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    WHERE l.id = ?
  `).get(id) as any;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  const liveDetail = getLiveDetail(id);
  res.json({
    id: row.id,
    jobId: row.job_id,
    jobName: row.job_name,
    jobType: row.job_type ?? null,
    accountName: row.account_name,
    ranAt: row.ran_at,
    status: row.status,
    message: row.message,
    detail: liveDetail ?? (row.detail ? JSON.parse(row.detail) : null),
  });
});

router.get('/', (req, res) => {
  const { jobId, limit, offset, showRetired = '0' } = req.query as Record<string, string>;
  const query = req.query as Record<string, unknown>;
  const paging = parsePaging(query);
  const search = textParam(query.search);
  const status = textParam(query.status);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (jobId) {
    const parsedJobId = Number(jobId);
    if (!Number.isInteger(parsedJobId) || parsedJobId <= 0) {
      res.status(400).json({ error: 'Invalid jobId' });
      return;
    }
    conditions.push('l.job_id = ?');
    params.push(parsedJobId);
  }
  if (showRetired !== '1') { conditions.push('l.retired = 0'); }
  if (status) {
    conditions.push('l.status = ?');
    params.push(status);
  }
  if (search) {
    conditions.push(`(
      COALESCE(j.name, '') LIKE ? ESCAPE '\\'
      OR COALESCE(a.name, '') LIKE ? ESCAPE '\\'
      OR COALESCE(l.message, '') LIKE ? ESCAPE '\\'
    )`);
    const like = `%${escapeLike(search)}%`;
    params.push(like, like, like);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const baseSql = `
    FROM job_logs l
    LEFT JOIN jobs j ON l.job_id = j.id
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    ${where}
  `;
  const selectSql = `
    SELECT l.id, l.job_id, l.ran_at, l.status, l.message, l.retired,
           j.name AS job_name, j.job_type,
           a.name AS account_name
    ${baseSql}
    ORDER BY l.ran_at DESC
    LIMIT ? OFFSET ?
  `;
  const toJson = (r: any) => ({
    id: r.id,
    jobId: r.job_id,
    jobName: r.job_name,
    jobType: r.job_type ?? null,
    accountName: r.account_name,
    ranAt: r.ran_at,
    status: r.status,
    message: r.message,
    retired: r.retired === 1,
  });

  if (!paging) {
    // Legacy limit/offset shape
    const parsedLimit = parsePositiveInt(limit, 50, 200);
    const parsedOffset = parseNonNegativeInt(offset, 0);
    const rows = db.prepare(selectSql).all(...params, parsedLimit, parsedOffset) as any[];
    res.json(rows.map(toJson));
    return;
  }

  const totalRow = db.prepare(`SELECT COUNT(*) AS total ${baseSql}`).get(...params) as { total: number };
  const rows = db.prepare(selectSql).all(...params, paging.limit, paging.offset) as any[];

  res.json({
    items: rows.map(toJson),
    total: totalRow.total,
    page: paging.page,
    pageSize: paging.pageSize,
  });
});

router.patch('/:id/retire', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT retired FROM job_logs WHERE id = ?').get(id) as { retired: number } | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  const newVal = row.retired ? 0 : 1;
  db.prepare('UPDATE job_logs SET retired = ? WHERE id = ?').run(newVal, id);
  res.json({ retired: newVal === 1 });
});

/**
 * POST /bulk-retire -- retire or bring back many rows at once, the bulk twin of
 * PATCH /:id/retire. `retired` is set outright rather than toggled per row: a selection
 * spanning both states is meant to end up all one way, which a toggle cannot do.
 */
router.post('/bulk-retire', (req, res) => {
  const ids = bulkIds(req.body);
  if (!ids) { res.status(400).json({ error: 'ids array required' }); return; }
  const retired = (req.body as { retired?: unknown }).retired === false ? 0 : 1;
  const update = db.prepare('UPDATE job_logs SET retired = ? WHERE id = ? AND retired != ?');
  const apply = db.transaction((list: number[]) => {
    let changed = 0;
    for (const id of list) changed += update.run(retired, id, retired).changes;
    return changed;
  });
  res.json({ changed: apply(ids), retired: retired === 1 });
});

/**
 * How long a cancelled run has to unwind before the row is stopped on its behalf.
 *
 * Aborting is cooperative, and not every wait a run sits in takes notice of it -- some
 * driver and network calls only come back when they are done. Left alone, the row stays
 * 'running' and the button spins for as long as that takes, which reads as a hang. The row
 * is settled here instead; whichever of the two gets there first wins it.
 */
const FORCE_STOP_GRACE_MS = 15_000;

router.post('/:id/cancel', (req, res) => {
  const logId = Number(req.params.id);
  if (isJobRunning(logId)) {
    cancelJob(logId);
    const timer = setTimeout(() => {
      const changed = db
        .prepare(
          "UPDATE job_logs SET status = 'failed', message = 'Force stopped' WHERE id = ? AND status = 'running'",
        )
        .run(logId);
      if (changed.changes)
        console.warn(
          `[logs] run ${logId} did not stop within ${FORCE_STOP_GRACE_MS / 1000}s of being cancelled; marked force stopped`,
        );
    }, FORCE_STOP_GRACE_MS);
    // Nothing should wait on this: it is a backstop, not work of its own
    timer.unref?.();
    res.json({ message: 'Cancel signal sent' });
    return;
  }
  // No live process: the row is likely orphaned after a restart. Force-mark a
  // stuck 'running' row as failed so it can be cleared from the UI. (issue #18)
  const row = db.prepare('SELECT status FROM job_logs WHERE id = ?').get(logId) as
    | { status: string }
    | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  if (row.status !== 'running') {
    res.status(404).json({ error: 'No running job found for this log entry' });
    return;
  }
  db.prepare("UPDATE job_logs SET status = 'failed', message = 'Force stopped' WHERE id = ?").run(logId);
  res.json({ message: 'Force stopped' });
});

export default router;
