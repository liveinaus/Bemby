import { Router } from 'express';
import { db } from '../db/database';
import { cancelJob, isJobRunning, getLiveDetail } from '../jobs/cancellation';
import { parsePaging, textParam, escapeLike, bulkIds } from './list-query';
import { inlineRunImages, compactStoredDetail } from '../jobs/runDetail';

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
    // The row keeps `shot:` references and the images sit beside the database; the panel
    // reads them inline, as it always has. Live detail is passed through the same way: a
    // run being written up while this is fetched has references in it too.
    detail: inlineRunImages(id, liveDetail ?? (row.detail ? JSON.parse(row.detail) : null)),
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
    SELECT l.id, l.job_id, l.ran_at, l.status, l.message, l.retired, l.detail_bytes,
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
    // What the run's log costs, row and screenshot files together. Null on history written
    // before the size was recorded, which the one-off pass fills in.
    sizeBytes: r.detail_bytes ?? null,
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

  // Summed from the recorded column rather than measured, so asking for the total does not
  // mean reading every detail in the table. The joins are dropped unless a filter actually
  // needs them: without them the sum is answered from the index over (retired,
  // detail_bytes) alone, which is the difference between 1ms and 55ms on a large table.
  const needsJoin = Boolean(search);
  const sizeSql = needsJoin
    ? `SELECT SUM(l.detail_bytes) AS bytes ${baseSql}`
    : `SELECT SUM(l.detail_bytes) AS bytes FROM job_logs l ${where}`;
  const sizeRow = db.prepare(sizeSql).get(...params) as { bytes: number | null };

  res.json({
    items: rows.map(toJson),
    total: totalRow.total,
    totalSizeBytes: sizeRow.bytes ?? 0,
    page: paging.page,
    pageSize: paging.pageSize,
  });
});

/** The screenshots a compact keeps when the request does not say. */
const DEFAULT_COMPACT_KEEP = 0;

function keepParam(body: unknown): number {
  const raw = (body as { keep?: unknown } | null)?.keep;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_COMPACT_KEEP;
  return Math.min(500, Math.floor(n));
}

/**
 * POST /:id/compact -- drops a stored run's screenshots, keeping the last `keep` of them
 * (none by default). The steps themselves stay: what a run did is most of what its log is
 * for, and it is the pictures that make one cost megabytes.
 */
router.post('/:id/compact', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT detail, detail_bytes FROM job_logs WHERE id = ?').get(id) as
    | { detail: string | null; detail_bytes: number | null }
    | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const compacted = compactStoredDetail(id, row.detail, keepParam(req.body));
  if (!compacted) {
    res.json({ dropped: 0, sizeBytes: row.detail_bytes ?? null, freedBytes: 0 });
    return;
  }
  db.prepare('UPDATE job_logs SET detail = ?, detail_bytes = ? WHERE id = ?').run(
    compacted.detail,
    compacted.bytes,
    id,
  );
  res.json({
    dropped: compacted.dropped,
    sizeBytes: compacted.bytes,
    freedBytes: Math.max(0, (row.detail_bytes ?? 0) - compacted.bytes),
  });
});

/**
 * POST /bulk-compact -- the same for many rows, or for every row the filters would show.
 * `ids` names them; `all: true` takes the lot, which is the one that matters to an operator
 * whose history has already grown.
 */
router.post('/bulk-compact', (req, res) => {
  const body = (req.body ?? {}) as { all?: unknown };
  const keep = keepParam(req.body);
  const ids = body.all === true
    ? (db.prepare("SELECT id FROM job_logs WHERE detail IS NOT NULL").all() as Array<{ id: number }>).map((r) => r.id)
    : bulkIds(req.body);
  if (!ids) { res.status(400).json({ error: 'ids array required' }); return; }

  const read = db.prepare('SELECT detail, detail_bytes FROM job_logs WHERE id = ?');
  const save = db.prepare('UPDATE job_logs SET detail = ?, detail_bytes = ? WHERE id = ?');
  let changed = 0;
  let dropped = 0;
  let freedBytes = 0;
  // Not one transaction: the files are deleted as it goes, so a rollback could not put them
  // back and would leave rows pointing at pictures that are gone.
  for (const id of ids) {
    const row = read.get(id) as { detail: string | null; detail_bytes: number | null } | undefined;
    if (!row) continue;
    const compacted = compactStoredDetail(id, row.detail, keep);
    if (!compacted) continue;
    save.run(compacted.detail, compacted.bytes, id);
    changed++;
    dropped += compacted.dropped;
    freedBytes += Math.max(0, (row.detail_bytes ?? 0) - compacted.bytes);
  }
  res.json({ changed, dropped, freedBytes });
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
