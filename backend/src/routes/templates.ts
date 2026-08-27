import { Router } from 'express';
import { db } from '../db/database';
import { refreshScheduler } from '../scheduler';
import { parsePaging, parseSort, textParam } from './list-query';
import { iconFromConfig, mergeIconIntoConfig } from '../jobs/configIcon';
import { jobOwnedConfig } from '../jobs/jobHandover';
import type { JobTemplate } from '../types';

const router = Router();

type TemplateRow = {
  id: number;
  name: string;
  job_type: string;
  bot_username: string;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
  created_at: string;
  run_every_days: number;
  run_every_days_max: number | null;
};

// Normalise a run-every-days range: min >= 1; max kept only when a valid integer
// strictly greater than min, else null (fixed interval).
function normalizeRunEvery(min: unknown, max: unknown): { min: number; max: number | null } {
  const lo = Math.max(1, Math.floor(Number(min ?? 1)) || 1);
  const hiNum = max == null || max === '' ? NaN : Math.floor(Number(max));
  const hi = Number.isFinite(hiNum) && hiNum > lo ? hiNum : null;
  return { min: lo, max: hi };
}

function rowToTemplate(row: TemplateRow): JobTemplate {
  return {
    id: row.id,
    name: row.name,
    jobType: row.job_type as JobTemplate['jobType'],
    botUsername: row.bot_username,
    timezone: row.timezone,
    replyTimeoutMs: row.reply_timeout_ms,
    retryMax: row.retry_max,
    enabled: Boolean(row.enabled),
    config: row.config ?? null,
    startCommand: row.start_command || '/start',
    checkinButton: row.checkin_button || '签到',
    createdAt: row.created_at,
    runEveryDays: row.run_every_days ?? 1,
    runEveryDaysMax: row.run_every_days_max ?? null,
    // Stored inside config; surfaced separately so callers never touch the JSON
    icon: iconFromConfig(row.config),
  };
}

function parseConfig(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    let c = JSON.parse(raw) as Record<string, unknown> | string;
    if (typeof c === 'string') c = JSON.parse(c) as Record<string, unknown>;
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

// Sync template fields to all linked jobs (enabled is job-specific, not synced)
export function syncLinkedJobs(templateId: number, t: TemplateRow) {
  // Config is merged per job below, so that job-owned settings survive
  db.prepare(`
    UPDATE jobs SET
      job_type = ?,
      bot_username = ?,
      timezone = ?,
      reply_timeout_ms = ?,
      retry_max = ?,
      start_command = ?,
      checkin_button = ?,
      run_every_days = ?,
      run_every_days_max = ?
    WHERE template_id = ?
  `).run(
    t.job_type,
    t.bot_username,
    t.timezone,
    t.reply_timeout_ms,
    t.retry_max,
    t.start_command,
    t.checkin_button,
    t.run_every_days ?? 1,
    t.run_every_days_max ?? null,
    templateId,
  );

  const tplCfg = parseConfig(t.config);
  // The template's own proxy stays on the template: a job stores a proxy id only when it
  // overrides one, and the runner falls back to the template's when it does not.
  delete tplCfg.proxyId;
  const linkedJobs = db
    .prepare('SELECT id, config FROM jobs WHERE template_id = ?')
    .all(templateId) as Array<{ id: number; config: string | null }>;
  for (const job of linkedJobs) {
    const merged = { ...tplCfg, ...jobOwnedConfig(parseConfig(job.config), t.job_type) };
    const hasValue = Object.values(merged).some(v => v !== undefined);
    db.prepare('UPDATE jobs SET config = ? WHERE id = ?')
      .run(hasValue ? JSON.stringify(merged) : null, job.id);
  }
  refreshScheduler();
}

const TEMPLATE_SORTS: Record<string, string> = {
  name: 't.name COLLATE NOCASE',
  type: 't.job_type',
  // asc shows enabled templates first, matching the previous client-side sort
  enabled: 'CASE WHEN t.enabled = 1 THEN 0 ELSE 1 END',
  botUrl: 't.bot_username COLLATE NOCASE',
  linkedJobs: 'linked_job_count',
  created: 't.created_at',
};

router.get('/', (req, res) => {
  const query = req.query as Record<string, unknown>;
  const paging = parsePaging(query);
  const search = textParam(query.search);
  const jobType = textParam(query.jobType);
  const enabled = textParam(query.enabled);
  const sortKey = textParam(query.sortKey);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (search) {
    // Fuzzy match against name and bot username (see db/fuzzy.ts)
    conditions.push("fuzzy_score(?, t.name || ' ' || t.bot_username) > 0");
    params.push(search);
  }
  if (jobType) {
    conditions.push('t.job_type = ?');
    params.push(jobType);
  }
  if (enabled === '1' || enabled === '0') {
    conditions.push('t.enabled = ?');
    params.push(Number(enabled));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // With a search active and no explicit column sort, order by match relevance
  const useRelevance = search && (!sortKey || sortKey === 'relevance');
  const orderClause = useRelevance
    ? 'search_score DESC, t.name COLLATE NOCASE'
    : parseSort(query, TEMPLATE_SORTS, TEMPLATE_SORTS.name);
  const scoreSelect = search
    ? ", fuzzy_score(?, t.name || ' ' || t.bot_username) AS search_score"
    : '';
  const scoreParams = search ? [search] : [];

  const baseSql = `
    FROM job_templates t
    LEFT JOIN jobs j ON j.template_id = t.id AND j.retired IS NULL
    ${where}
    GROUP BY t.id
  `;

  if (!paging) {
    const rows = db.prepare(`
      SELECT t.*, COUNT(j.id) AS linked_job_count ${scoreSelect}
      ${baseSql}
      ORDER BY ${orderClause}
    `).all(...scoreParams, ...params) as (TemplateRow & { linked_job_count: number })[];
    res.json(rows.map(r => ({ ...rowToTemplate(r), linkedJobCount: r.linked_job_count })));
    return;
  }

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total FROM job_templates t ${where}
  `).get(...params) as { total: number };

  const rows = db.prepare(`
    SELECT t.*, COUNT(j.id) AS linked_job_count ${scoreSelect}
    ${baseSql}
    ORDER BY ${orderClause}
    LIMIT ? OFFSET ?
  `).all(...scoreParams, ...params, paging.limit, paging.offset) as (TemplateRow & { linked_job_count: number })[];

  res.json({
    items: rows.map(r => ({ ...rowToTemplate(r), linkedJobCount: r.linked_job_count })),
    total: totalRow.total,
    page: paging.page,
    pageSize: paging.pageSize,
  });
});

router.post('/', (req, res) => {
  const {
    name,
    jobType,
    botUsername,
    timezone,
    replyTimeoutMs,
    retryMax,
    config,
    startCommand,
    checkinButton,
    runEveryDays,
    runEveryDaysMax,
    icon,
  } = req.body as Record<string, any>;

  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const runEvery = normalizeRunEvery(runEveryDays, runEveryDaysMax);
  const result = db.prepare(`
    INSERT INTO job_templates
      (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, config, start_command, checkin_button, run_every_days, run_every_days_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    jobType ?? 'checkin',
    (botUsername as string | undefined)?.replace(/^@+/, '') ?? '',
    timezone ?? '',
    Number(replyTimeoutMs ?? 40000),
    Number(retryMax ?? 5),
    mergeIconIntoConfig(config ?? undefined, null, icon),
    (startCommand as string | undefined)?.trim() || '/start',
    (checkinButton as string | undefined)?.trim() || '签到',
    runEvery.min,
    runEvery.max,
  );

  const row = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(result.lastInsertRowid) as TemplateRow;
  res.status(201).json(rowToTemplate(row));
});

/**
 * `<name> (copy)`, or `(copy 2)` and up when that is taken. Templates are picked from a
 * list by name, so a duplicate reading exactly like its source is of little use.
 */
function copyName(name: string): string {
  const taken = new Set(
    (db.prepare('SELECT name FROM job_templates').all() as { name: string }[]).map(r => r.name),
  );
  let candidate = `${name} (copy)`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name} (copy ${n})`;
  return candidate;
}

router.post('/:id/duplicate', (req, res) => {
  const source = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id) as TemplateRow | undefined;
  if (!source) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // Everything the source configures, nothing about its identity: the copy starts with no
  // linked jobs, which stay with the original, and created_at is left to default so the copy
  // is dated when it was made rather than inheriting the source's date.
  const result = db.prepare(`
    INSERT INTO job_templates
      (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button, run_every_days, run_every_days_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    copyName(source.name),
    source.job_type,
    source.bot_username,
    source.timezone,
    source.reply_timeout_ms,
    source.retry_max,
    source.enabled,
    source.config,
    source.start_command,
    source.checkin_button,
    source.run_every_days,
    source.run_every_days_max,
  );

  const row = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(result.lastInsertRowid) as TemplateRow;
  res.status(201).json(rowToTemplate(row));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id) as TemplateRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const {
    name,
    jobType,
    botUsername,
    timezone,
    replyTimeoutMs,
    retryMax,
    enabled,
    config,
    startCommand,
    checkinButton,
    runEveryDays,
    runEveryDaysMax,
    icon,
  } = req.body as Record<string, any>;

  const runEvery = normalizeRunEvery(
    runEveryDays !== undefined ? runEveryDays : existing.run_every_days,
    runEveryDaysMax !== undefined ? runEveryDaysMax : existing.run_every_days_max,
  );
  const updated: TemplateRow = {
    ...existing,
    name: name ?? existing.name,
    job_type: jobType ?? existing.job_type,
    bot_username: (botUsername as string | undefined)?.replace(/^@+/, '') ?? existing.bot_username,
    timezone: timezone ?? existing.timezone,
    reply_timeout_ms: Number(replyTimeoutMs ?? existing.reply_timeout_ms),
    retry_max: Number(retryMax ?? existing.retry_max),
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    // The icon lives in this column too, so it is merged rather than overwritten: a form
    // that says nothing about icons must not clear the one already set.
    config: mergeIconIntoConfig(config, existing.config, icon),
    start_command: startCommand !== undefined
      ? ((startCommand as string).trim() || '/start')
      : existing.start_command,
    checkin_button: checkinButton !== undefined
      ? ((checkinButton as string).trim() || '签到')
      : existing.checkin_button,
    run_every_days: runEvery.min,
    run_every_days_max: runEvery.max,
  };

  db.prepare(`
    UPDATE job_templates SET
      name = ?, job_type = ?, bot_username = ?, timezone = ?,
      reply_timeout_ms = ?, retry_max = ?, enabled = ?,
      config = ?, start_command = ?, checkin_button = ?, run_every_days = ?, run_every_days_max = ?
    WHERE id = ?
  `).run(
    updated.name,
    updated.job_type,
    updated.bot_username,
    updated.timezone,
    updated.reply_timeout_ms,
    updated.retry_max,
    updated.enabled,
    updated.config,
    updated.start_command,
    updated.checkin_button,
    updated.run_every_days,
    updated.run_every_days_max,
    req.params.id,
  );

  syncLinkedJobs(Number(req.params.id), updated);

  const row = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id) as TemplateRow;
  res.json(rowToTemplate(row));
});

router.delete('/:id', (req, res) => {
  // ON DELETE SET NULL handles unlinking jobs
  db.prepare('DELETE FROM job_templates WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// ── Bulk enable / disable linked jobs ────────────────────────────────────────

router.put('/:id/jobs/enabled', (req, res) => {
  const { enabled } = req.body as { enabled: boolean };
  db.prepare('UPDATE jobs SET enabled = ? WHERE template_id = ?').run(enabled ? 1 : 0, req.params.id);
  refreshScheduler();
  res.json({ ok: true });
});

// ── Candidate accounts (no existing job for this template) ───────────────────

router.get('/:id/available-accounts', (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, phone_number, auth_status, disabled, tg_display_name
    FROM tg_accounts
    WHERE (disabled = 0 OR disabled IS NULL)
      AND id NOT IN (
        SELECT account_id FROM jobs
        WHERE template_id = ? AND account_id IS NOT NULL AND retired IS NULL
      )
    ORDER BY name COLLATE NOCASE
  `).all(req.params.id) as Array<{
    id: number; name: string; phone_number: string; auth_status: string; disabled: number; tg_display_name: string | null;
  }>;

  res.json(rows.map(r => ({
    id: r.id,
    name: r.name,
    phoneNumber: r.phone_number,
    authStatus: r.auth_status,
    tgDisplayName: r.tg_display_name ?? null,
  })));
});

// ── Bulk create jobs from template ───────────────────────────────────────────

type CreateJobEntry = {
  accountId: number;
  name: string;
  config?: Record<string, unknown>;
};

router.post('/:id/create-jobs', (req, res) => {
  const template = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id) as TemplateRow | undefined;
  if (!template) { res.status(404).json({ error: 'Not found' }); return; }

  const { jobs, scheduleWindowStart, scheduleWindowEnd, enabled } = req.body as {
    jobs: CreateJobEntry[];
    scheduleWindowStart: number;
    scheduleWindowEnd: number;
    /** Create them switched off, for a template nobody wants running on its own schedule yet. */
    enabled?: boolean;
  };
  // Absent means on, which is what creating from a template always did
  const startEnabled = enabled === false ? 0 : 1;

  if (!Array.isArray(jobs) || !jobs.length) {
    res.status(400).json({ error: 'jobs array is required' }); return;
  }

  const createdIds: number[] = [];

  db.transaction(() => {
    for (const j of jobs) {
      // For embywatch, merge per-job credentials into template config
      let jobConfig = template.config;
      if (j.config && template.job_type === 'embywatch') {
        const tplCfg = template.config ? JSON.parse(template.config) : {};
        jobConfig = JSON.stringify({ ...tplCfg, ...j.config });
      }

      const result = db.prepare(`
        INSERT INTO jobs (
          name, account_id, job_type, bot_username,
          schedule_window_start, schedule_window_end, timezone,
          reply_timeout_ms, retry_max, enabled, config,
          start_command, checkin_button, template_id,
          run_every_days, run_every_days_max
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        j.name,
        j.accountId,
        template.job_type,
        template.bot_username,
        Number(scheduleWindowStart),
        Number(scheduleWindowEnd),
        template.timezone,
        template.reply_timeout_ms,
        template.retry_max,
        startEnabled,
        jobConfig,
        template.start_command,
        template.checkin_button,
        template.id,
        // Cadence is the template's to set, the same as it is on a save that syncs it down;
        // without it every job created here would start out on the column default of 1
        template.run_every_days ?? 1,
        template.run_every_days_max ?? null,
      );
      createdIds.push(Number(result.lastInsertRowid));
    }
  })();

  refreshScheduler();
  res.status(201).json({ created: createdIds.length, ids: createdIds });
});

export default router;
