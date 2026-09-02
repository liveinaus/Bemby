import { Router } from "express";
import { db } from "../db/database";
import { refreshScheduler } from "../scheduler";
import { startManualJobRun } from "../jobs/manualRun";
import { rowToJob, type JobRow } from "../jobs/jobRows";
import { testEmbyConnection } from "../jobs/embywatch";
import { parsePaging, parseSort, textParam, escapeLike, bulkIds } from "./list-query";
import { mergeIconIntoConfig } from "../jobs/configIcon";
import { makeJobProxyResolver } from "../jobs/jobProxy";

const router = Router();

// Normalise a run-every-days range: min is clamped to >= 1; max is kept only
// when it is a valid integer strictly greater than min, otherwise null (fixed).
export function normalizeRunEvery(min: unknown, max: unknown): { min: number; max: number | null } {
  const lo = Math.max(1, Math.floor(Number(min ?? 1)) || 1);
  const hiNum = max == null || max === "" ? NaN : Math.floor(Number(max));
  const hi = Number.isFinite(hiNum) && hiNum > lo ? hiNum : null;
  return { min: lo, max: hi };
}

const JOB_SORTS: Record<string, string> = {
  name: "j.name COLLATE NOCASE",
  account: "account_name COLLATE NOCASE",
  type: "j.job_type",
  botUrl: "j.bot_username COLLATE NOCASE",
  window: "j.schedule_window_start",
  // asc shows enabled jobs first, matching the previous client-side sort
  enabled: "CASE WHEN j.enabled = 1 THEN 0 ELSE 1 END",
  // asc puts never-succeeded jobs first, then oldest success
  lastSuccess: "j.last_success_at",
};

router.get("/", (req, res) => {
  const query = req.query as Record<string, unknown>;
  const paging = parsePaging(query);
  const search = textParam(query.search);
  const jobType = textParam(query.jobType);
  const accountId = textParam(query.accountId);
  const botUsername = textParam(query.botUsername);
  const templateId = textParam(query.templateId);
  const enabled = textParam(query.enabled);

  const conditions: string[] = ["j.retired IS NULL"];
  const params: (string | number)[] = [];

  if (search) {
    conditions.push("j.name LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(search)}%`);
  }
  if (jobType) {
    conditions.push("j.job_type = ?");
    params.push(jobType);
  }
  if (accountId) {
    const parsed = Number(accountId);
    if (!Number.isInteger(parsed)) {
      res.status(400).json({ error: "Invalid accountId" });
      return;
    }
    conditions.push("j.account_id = ?");
    params.push(parsed);
  }
  if (botUsername) {
    conditions.push("j.bot_username = ?");
    params.push(botUsername);
  }
  if (templateId) {
    const parsed = Number(templateId);
    if (!Number.isInteger(parsed)) {
      res.status(400).json({ error: "Invalid templateId" });
      return;
    }
    conditions.push("j.template_id = ?");
    params.push(parsed);
  }
  if (enabled === "1" || enabled === "0") {
    conditions.push("j.enabled = ?");
    params.push(Number(enabled));
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const orderClause = parseSort(query, JOB_SORTS, JOB_SORTS.name);
  const baseSql = `
    FROM jobs j
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    ${where}
  `;

  // One resolver per request, so the proxy and provider lists are read once for the page
  const jobProxy = makeJobProxyResolver();
  const toJob = (row: JobRow) => ({ ...rowToJob(row), effectiveProxy: jobProxy(row) });

  if (!paging) {
    const rows = db
      .prepare(
        `SELECT j.*, a.name AS account_name, a.proxy_id AS account_proxy_id
         ${baseSql} ORDER BY ${orderClause}`,
      )
      .all(...params) as JobRow[];
    res.json(rows.map(toJob));
    return;
  }

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total ${baseSql}`)
    .get(...params) as { total: number };

  const rows = db
    .prepare(`
      SELECT j.*, a.name AS account_name, a.proxy_id AS account_proxy_id
      ${baseSql}
      ORDER BY ${orderClause}
      LIMIT ? OFFSET ?
    `)
    .all(...params, paging.limit, paging.offset) as JobRow[];

  // Facets let the client build filter dropdowns without loading every row
  const botUsernames = db
    .prepare(`
      SELECT DISTINCT bot_username FROM jobs
      WHERE retired IS NULL AND template_id IS NULL AND bot_username != ''
      ORDER BY bot_username COLLATE NOCASE
    `)
    .all() as Array<{ bot_username: string }>;
  const templatesInUse = db
    .prepare(`
      SELECT DISTINCT t.id, t.name FROM jobs j
      JOIN job_templates t ON j.template_id = t.id
      WHERE j.retired IS NULL
      ORDER BY t.name COLLATE NOCASE
    `)
    .all() as Array<{ id: number; name: string }>;

  res.json({
    items: rows.map(toJob),
    total: totalRow.total,
    page: paging.page,
    pageSize: paging.pageSize,
    facets: {
      botUsernames: botUsernames.map((r) => r.bot_username),
      templates: templatesInUse,
    },
  });
});

// Verify Emby server reachability and credentials without creating a job
router.post("/test-emby", async (req, res) => {
  const { serverUrl, username, password, userAgent, proxyId } =
    req.body as Record<string, string | undefined>;
  const { ignoreSslErrors, proxyPool } = req.body as {
    ignoreSslErrors?: boolean;
    proxyPool?: string[];
  };
  if (!serverUrl || !username || !password) {
    res
      .status(400)
      .json({ error: "serverUrl, username and password are required" });
    return;
  }
  if (!/^https?:\/\//i.test(serverUrl)) {
    res
      .status(400)
      .json({ error: "serverUrl must start with http:// or https://" });
    return;
  }
  const result = await testEmbyConnection(serverUrl, {
    username,
    password,
    userAgent,
    proxyId,
    proxyPool: Array.isArray(proxyPool) ? proxyPool : undefined,
    ignoreSslErrors: ignoreSslErrors === true,
  });
  res.json(result);
});

router.post("/", (req, res) => {
  const {
    name,
    accountId,
    jobType,
    botUsername,
    scheduleWindowStart,
    scheduleWindowEnd,
    timezone,
    replyTimeoutMs,
    retryMax,
    enabled,
    config,
    startCommand,
    checkinButton,
    templateId,
    runEveryDays,
    runEveryDaysMax,
    oneTime,
    icon,
  } = req.body as Record<string, any>;

  const resolvedType = jobType ?? "checkin";
  const needsAccount =
    resolvedType === "checkin" ||
    resolvedType === "custom" ||
    resolvedType === "autoreg";
  // A custom job need not target a bot at all: its actions can each name their own
  // contact, or drive a page that never touches Telegram.
  if (!name || (needsAccount && !accountId) || (resolvedType !== "custom" && !botUsername)) {
    res.status(400).json({
      error:
        "name is required; botUsername is required for every type except custom; " +
        "accountId is required for checkin, custom and autoreg jobs",
    });
    return;
  }

  const runEvery = normalizeRunEvery(runEveryDays, runEveryDaysMax);
  const result = db
    .prepare(
      `
    INSERT INTO jobs
      (name, account_id, job_type, bot_username, schedule_window_start, schedule_window_end,
       timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button, template_id, run_every_days, run_every_days_max, one_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      name,
      accountId ? Number(accountId) : null,
      resolvedType,
      (botUsername as string).replace(/^@+/, ""),
      Number(scheduleWindowStart ?? 1400),
      Number(scheduleWindowEnd ?? 1600),
      timezone ?? "",
      Number(replyTimeoutMs ?? 40000),
      Number(retryMax ?? 5),
      enabled !== false ? 1 : 0,
      mergeIconIntoConfig(config ?? undefined, null, icon),
      (startCommand as string | undefined)?.trim() || "/start",
      (checkinButton as string | undefined)?.trim() || "签到",
      templateId ? Number(templateId) : null,
      runEvery.min,
      runEvery.max,
      oneTime ? 1 : 0,
    );

  const row = db
    .prepare(
      "SELECT j.*, a.name AS account_name FROM jobs j LEFT JOIN tg_accounts a ON j.account_id = a.id WHERE j.id = ?",
    )
    .get(result.lastInsertRowid) as JobRow;
  refreshScheduler();
  res.status(201).json(rowToJob(row));
});

/**
 * PUT /bulk -- one patch applied to many jobs in a single statement each, inside one
 * transaction, with the scheduler rebuilt once at the end. The per-job route rebuilds it on
 * every call, which is what made enabling two hundred jobs from the panel so heavy.
 *
 * Registered before "/:id" so express does not read the literal path as an id.
 */
router.put("/bulk", (req, res) => {
  const ids = bulkIds(req.body);
  if (!ids) {
    res.status(400).json({ error: "ids array required" });
    return;
  }

  const { enabled, scheduleWindowStart, scheduleWindowEnd } = req.body as Record<string, any>;
  const sets: string[] = [];
  const values: unknown[] = [];
  if (enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(enabled ? 1 : 0);
  }
  for (const [field, column] of [
    [scheduleWindowStart, "schedule_window_start"],
    [scheduleWindowEnd, "schedule_window_end"],
  ] as const) {
    if (field === undefined) continue;
    const value = Number(field);
    if (!Number.isFinite(value)) {
      res.status(400).json({ error: `${column} must be a number` });
      return;
    }
    sets.push(`${column} = ?`);
    values.push(value);
  }
  if (!sets.length) {
    res.status(400).json({ error: "nothing to update" });
    return;
  }

  // Retired jobs are out of the panel's reach, so a stale selection cannot bring one back
  const update = db.prepare(
    `UPDATE jobs SET ${sets.join(", ")} WHERE id = ? AND retired IS NULL`,
  );
  const apply = db.transaction((list: number[]) => {
    let changed = 0;
    for (const id of list) changed += update.run(...values, id).changes;
    return changed;
  });
  const updated = apply(ids);

  refreshScheduler();
  res.json({ updated });
});

/** POST /bulk-retire -- retire many jobs at once, the bulk twin of DELETE /:id. */
router.post("/bulk-retire", (req, res) => {
  const ids = bulkIds(req.body);
  if (!ids) {
    res.status(400).json({ error: "ids array required" });
    return;
  }
  const update = db.prepare(
    "UPDATE jobs SET retired = datetime('now') WHERE id = ? AND retired IS NULL",
  );
  const apply = db.transaction((list: number[]) => {
    let changed = 0;
    for (const id of list) changed += update.run(id).changes;
    return changed;
  });
  const retired = apply(ids);

  refreshScheduler();
  res.json({ retired });
});

router.put("/:id", (req, res) => {
  const existing = db
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .get(req.params.id) as JobRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const {
    name,
    accountId,
    jobType,
    botUsername,
    scheduleWindowStart,
    scheduleWindowEnd,
    timezone,
    replyTimeoutMs,
    retryMax,
    enabled,
    config,
    startCommand,
    checkinButton,
    templateId,
    runEveryDays,
    runEveryDaysMax,
    oneTime,
    icon,
  } = req.body as Record<string, any>;

  // When linked to a template, template-controlled fields are read-only
  const isLinked = existing.template_id != null && templateId === undefined;
  const resolvedTemplateId = templateId !== undefined
    ? (templateId ? Number(templateId) : null)
    : existing.template_id;

  const updatedType = isLinked ? existing.job_type : (jobType ?? existing.job_type);
  const runEvery = normalizeRunEvery(
    runEveryDays !== undefined ? runEveryDays : existing.run_every_days,
    runEveryDaysMax !== undefined ? runEveryDaysMax : existing.run_every_days_max,
  );
  db.prepare(
    `
    UPDATE jobs SET
      name = ?, account_id = ?, job_type = ?, bot_username = ?,
      schedule_window_start = ?, schedule_window_end = ?, timezone = ?,
      reply_timeout_ms = ?, retry_max = ?, enabled = ?, config = ?,
      start_command = ?, checkin_button = ?, template_id = ?, run_every_days = ?, run_every_days_max = ?,
      one_time = ?
    WHERE id = ?
  `,
  ).run(
    name ?? existing.name,
    accountId !== undefined ? (accountId ? Number(accountId) : null) : (existing.account_id ?? null),
    updatedType,
    isLinked ? existing.bot_username : ((botUsername as string | undefined)?.replace(/^@+/, "") ?? existing.bot_username),
    Number(scheduleWindowStart ?? existing.schedule_window_start),
    Number(scheduleWindowEnd ?? existing.schedule_window_end),
    isLinked ? existing.timezone : (timezone ?? existing.timezone),
    isLinked ? existing.reply_timeout_ms : Number(replyTimeoutMs ?? existing.reply_timeout_ms),
    isLinked ? existing.retry_max : Number(retryMax ?? existing.retry_max),
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    // embywatch template-linked jobs store credentials in the job; allow config updates.
    // The icon rides in the same column but is cosmetic, so it stays editable even where
    // the rest of the config is frozen, and survives a save that says nothing about it.
    mergeIconIntoConfig(
      (isLinked && existing.job_type !== "embywatch") ? undefined : config,
      existing.config,
      icon,
    ),
    isLinked ? existing.start_command : (startCommand !== undefined ? ((startCommand as string).trim() || "/start") : existing.start_command),
    isLinked ? existing.checkin_button : (checkinButton !== undefined ? ((checkinButton as string).trim() || "签到") : existing.checkin_button),
    resolvedTemplateId,
    runEvery.min,
    runEvery.max,
    // Template-controlled, like the cadence beside it: a linked job follows its template,
    // which pushes the value down on every template save
    isLinked ? existing.one_time : (oneTime !== undefined ? (oneTime ? 1 : 0) : existing.one_time),
    req.params.id,
  );

  const row = db
    .prepare(
      "SELECT j.*, a.name AS account_name FROM jobs j LEFT JOIN tg_accounts a ON j.account_id = a.id WHERE j.id = ?",
    )
    .get(req.params.id) as JobRow;
  refreshScheduler();
  res.json(rowToJob(row));
});

router.delete("/:id", (req, res) => {
  db.prepare("UPDATE jobs SET retired = datetime('now') WHERE id = ?").run(req.params.id);
  refreshScheduler();
  res.status(204).send();
});

// Manual trigger. The run itself continues in the background; startManualJobRun
// is shared with the background bulk runner.
router.post("/:id/run", async (req, res) => {
  const started = startManualJobRun(req.params.id);
  if (!started.ok) {
    res.status(started.status).json({ error: started.error });
    return;
  }
  res.json({ message: "Job triggered", logId: started.logId });
});

export default router;
