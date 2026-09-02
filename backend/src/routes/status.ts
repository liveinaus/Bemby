import { Router } from 'express';
import { getSchedulerStatus, skipNextRun } from '../scheduler';
import { memoryReport } from '../monitor/memory';
import {
  readSystemLog,
  clearSystemLog,
  type SystemLogLevel,
} from '../system/consoleLog';

const router = Router();

router.get('/', (req, res) => {
  res.json(getSchedulerStatus());
});

// POST /skip/:jobId -- give up the pending run and arm the one after it. The job keeps its
// schedule; this is calling off one occurrence, not disabling anything.
router.post('/skip/:jobId', (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    res.status(400).json({ error: 'Invalid job id' });
    return;
  }
  const result = skipNextRun(jobId);
  if (!result.ok) {
    res.status(404).json({ error: 'That job has no scheduled run' });
    return;
  }
  res.json(result);
});

// Separate path so the schedule list above keeps returning a bare array
router.get('/memory', (req, res) => {
  res.json(memoryReport());
});

const LOG_LEVELS = ['debug', 'log', 'info', 'warn', 'error'] as const;

function parseLevel(raw: unknown): SystemLogLevel | undefined {
  return LOG_LEVELS.includes(raw as SystemLogLevel) ? (raw as SystemLogLevel) : undefined;
}

/**
 * The container log, read from inside. `since` makes the poll incremental: the viewer
 * passes back the cursor it was given and gets only what has printed since.
 */
router.get('/system-log', (req, res) => {
  const { since, level, search, limit } = req.query as Record<string, string>;
  const parsedSince = Number(since);
  const parsedLimit = Number(limit);
  res.json(
    readSystemLog({
      since: Number.isFinite(parsedSince) ? Math.max(0, Math.floor(parsedSince)) : undefined,
      level: parseLevel(level),
      search: typeof search === 'string' && search.trim() ? search.trim() : undefined,
      limit: Number.isFinite(parsedLimit) ? Math.min(20000, Math.max(1, Math.floor(parsedLimit))) : undefined,
    }),
  );
});

router.post('/system-log/clear', (_req, res) => {
  res.json({ cleared: clearSystemLog() });
});

export default router;
