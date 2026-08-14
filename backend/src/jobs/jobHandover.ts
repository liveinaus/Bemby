// Pointing a job at a different template, mid-run. What a job whose purpose changes needs: one
// that exists to register an account signs it up once, and from then on is that account's daily
// job. Same row, same id -- which matters, because the credentials it filed away are filed under
// `{jobId}` and the template taking over reads them back the same way.
//
// The row is rewritten the way saving a template rewrites its linked jobs (see syncLinkedJobs),
// so a job handed over here is indistinguishable from one that was linked to the new template all
// along. No call to the scheduler: it re-reads every five minutes on its own, and a job module
// reaching back into it would close a loop between the two.

import { db } from "../db/database";

/** A job's own config, as stored: sometimes a JSON string of a JSON string. */
export function parseJobConfig(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    let c = JSON.parse(raw) as Record<string, unknown> | string;
    if (typeof c === "string") c = JSON.parse(c) as Record<string, unknown>;
    return c && typeof c === "object" ? c : {};
  } catch {
    return {};
  }
}

/**
 * Config settings a job owns, which a template sync must leave alone: its proxy override
 * (blank means it follows the template's, resolved at run time), its icon if it was given
 * one of its own, and, for Emby Watch, the credentials that were never the template's to
 * hold. A job with no icon of its own has none here, so it picks the template's up on sync.
 *
 * The pool travels with the proxy id. `random` on its own draws from the whole proxy list, so
 * an override kept without its pool is not the same override -- it is a wider one, and the job
 * would quietly start exiting through proxies nobody chose for it.
 */
export function jobOwnedConfig(
  jobCfg: Record<string, unknown>,
  jobType: string,
): Record<string, unknown> {
  const own: Record<string, unknown> = {};
  if (typeof jobCfg.proxyId === "string" && jobCfg.proxyId) {
    own.proxyId = jobCfg.proxyId;
    if (Array.isArray(jobCfg.proxyPool) && jobCfg.proxyPool.length) {
      own.proxyPool = jobCfg.proxyPool;
    }
  }
  if (typeof jobCfg.icon === "string" && jobCfg.icon) own.icon = jobCfg.icon;
  if (jobType === "embywatch") {
    own.username = jobCfg.username;
    own.password = jobCfg.password;
  }
  return own;
}

export type JobHandover = {
  /** The job to hand over: the one the run belongs to. */
  jobId: number;
  /** The template to run from now on, by name or by id. */
  template: string;
  /** New name for the job. Blank leaves the one it has. */
  name?: string;
  /** Whether it runs on the schedule from now on. Undefined leaves it as it is. */
  enabled?: boolean;
};

export type JobHandoverResult = {
  templateId: number;
  templateName: string;
  /** What the job is called now, whether or not this changed it. */
  name: string;
  enabled: boolean;
  /** Set when the job was already on that template, so the log can say so. */
  alreadyLinked: boolean;
};

type TemplateRow = {
  id: number;
  name: string;
  job_type: string;
  bot_username: string;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
  run_every_days: number | null;
  run_every_days_max: number | null;
};

type JobRow = {
  id: number;
  name: string;
  enabled: number;
  config: string | null;
  template_id: number | null;
};

/** The template asked for, by id when the value is a number and by name otherwise. */
function findTemplate(wanted: string): TemplateRow | undefined {
  const trimmed = wanted.trim();
  if (!trimmed) throw new Error("no template named to hand over to");
  const row = /^\d+$/.test(trimmed)
    ? db.prepare("SELECT * FROM job_templates WHERE id = ?").get(Number(trimmed))
    : db
        .prepare("SELECT * FROM job_templates WHERE name = ? COLLATE NOCASE")
        .get(trimmed);
  return row as TemplateRow | undefined;
}

export function handOverJob(q: JobHandover): JobHandoverResult {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(q.jobId) as JobRow | undefined;
  if (!job) throw new Error(`job ${q.jobId} is no longer there`);

  const template = findTemplate(q.template);
  if (!template) throw new Error(`no template is called \`${q.template.trim()}\``);

  // The template's own proxy stays on the template: a job stores a proxy id only when it
  // overrides one, and the runner falls back to the template's when it does not
  const tplCfg = parseJobConfig(template.config);
  delete tplCfg.proxyId;
  const merged = { ...tplCfg, ...jobOwnedConfig(parseJobConfig(job.config), template.job_type) };
  const hasValue = Object.values(merged).some((v) => v !== undefined);

  const name = q.name?.trim() || job.name;
  const enabled = q.enabled === undefined ? job.enabled !== 0 : q.enabled;

  db.prepare(
    `
    UPDATE jobs SET
      name = ?, job_type = ?, bot_username = ?, timezone = ?, reply_timeout_ms = ?,
      retry_max = ?, start_command = ?, checkin_button = ?, run_every_days = ?,
      run_every_days_max = ?, config = ?, template_id = ?, enabled = ?
    WHERE id = ?
  `,
  ).run(
    name,
    template.job_type,
    template.bot_username,
    template.timezone,
    template.reply_timeout_ms,
    template.retry_max,
    template.start_command,
    template.checkin_button,
    template.run_every_days ?? 7,
    template.run_every_days_max ?? null,
    hasValue ? JSON.stringify(merged) : null,
    template.id,
    enabled ? 1 : 0,
    job.id,
  );

  return {
    templateId: template.id,
    templateName: template.name,
    name,
    enabled,
    alreadyLinked: job.template_id === template.id,
  };
}
