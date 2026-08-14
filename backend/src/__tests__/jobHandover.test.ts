// Pointing a job at a different template mid-run: what the signup job does once the account it
// created exists. The row has to come out indistinguishable from one that was linked to the new
// template all along, and it has to keep its id -- the credentials it filed away are filed under
// that id, and the template taking over reads them back the same way.

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/database";
import { handOverJob } from "../jobs/jobHandover";

function makeTemplate(name: string, extra: Record<string, unknown> = {}): number {
  const row = {
    job_type: "custom",
    bot_username: "",
    timezone: "Australia/Sydney",
    reply_timeout_ms: 40000,
    retry_max: 2,
    config: JSON.stringify({ actions: [{ type: "open_url", url: "https://example.com" }] }),
    start_command: "/start",
    checkin_button: "签到",
    run_every_days: 1,
    run_every_days_max: null,
    ...extra,
  };
  const info = db
    .prepare(
      `INSERT INTO job_templates
         (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, enabled, config,
          start_command, checkin_button, run_every_days, run_every_days_max)
       VALUES (@name, @job_type, @bot_username, @timezone, @reply_timeout_ms, @retry_max, 1,
               @config, @start_command, @checkin_button, @run_every_days, @run_every_days_max)`,
    )
    .run({ name, ...row });
  return Number(info.lastInsertRowid);
}

function makeJob(name: string, templateId: number, config: string | null): number {
  const info = db
    .prepare(
      `INSERT INTO jobs
         (name, account_id, job_type, bot_username, schedule_window_start, schedule_window_end,
          timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button,
          template_id, run_every_days)
       VALUES (?, NULL, 'custom', '', 1400, 1600, '', 40000, 1, 0, ?, '/start', '签到', ?, 3650)`,
    )
    .run(name, config, templateId);
  return Number(info.lastInsertRowid);
}

const jobRow = (id: number) =>
  db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, any>;

let signupId: number;
let checkinId: number;
let jobId: number;

beforeEach(() => {
  db.prepare("DELETE FROM jobs").run();
  db.prepare("DELETE FROM job_templates").run();
  signupId = makeTemplate("Site signup", { run_every_days: 3650 });
  checkinId = makeTemplate("Site checkin", {
    config: JSON.stringify({ actions: [{ type: "open_url", url: "https://example.com/board" }] }),
    retry_max: 5,
    run_every_days: 1,
  });
  jobId = makeJob("Site signup - 012", signupId, JSON.stringify({ actions: [], proxyId: "px1" }));
});

describe("handOverJob", () => {
  it("takes the new template's settings, keeping the job's id", () => {
    const done = handOverJob({ jobId, template: "Site checkin", name: "Site checkin - 012" });

    expect(done).toMatchObject({
      templateId: checkinId,
      templateName: "Site checkin",
      name: "Site checkin - 012",
      alreadyLinked: false,
    });
    const row = jobRow(jobId);
    expect(row.id).toBe(jobId);
    expect(row.name).toBe("Site checkin - 012");
    expect(row.template_id).toBe(checkinId);
    // Rewritten from the template, exactly as saving that template would
    expect(row.retry_max).toBe(5);
    expect(row.run_every_days).toBe(1);
    expect(row.timezone).toBe("Australia/Sydney");
    expect(JSON.parse(row.config).actions[0].url).toBe("https://example.com/board");
  });

  it("leaves the settings a job owns rather than the template", () => {
    handOverJob({ jobId, template: "Site checkin" });
    // The proxy override is the job's own: a handover must not take it away, or the account
    // would start signing in from an exit it never registered from
    expect(JSON.parse(jobRow(jobId).config).proxyId).toBe("px1");
  });

  it("keeps a random override's pool, which is part of the override", () => {
    db.prepare("UPDATE jobs SET config = ? WHERE id = ?").run(
      JSON.stringify({ actions: [], proxyId: "random", proxyPool: ["px1", "px2"], icon: "ns" }),
      jobId,
    );
    handOverJob({ jobId, template: "Site checkin" });
    const cfg = JSON.parse(jobRow(jobId).config);
    // Without the pool, `random` widens to the whole proxy list -- a different override
    expect(cfg.proxyId).toBe("random");
    expect(cfg.proxyPool).toEqual(["px1", "px2"]);
    expect(cfg.icon).toBe("ns");
  });

  it("does not copy the template's proxy onto a job that had no override", () => {
    db.prepare("UPDATE jobs SET config = ? WHERE id = ?").run(
      JSON.stringify({ actions: [] }),
      jobId,
    );
    db.prepare("UPDATE job_templates SET config = ? WHERE id = ?").run(
      JSON.stringify({ actions: [], proxyId: "tplProxy" }),
      checkinId,
    );
    handOverJob({ jobId, template: "Site checkin" });
    // The other half of the rule: a job stores a proxy id only where it overrides one, and the
    // runner falls back to the template's at run time. Writing it down here would turn a job that
    // follows its template into one pinned to whatever the template said today.
    expect(JSON.parse(jobRow(jobId).config).proxyId).toBeUndefined();
  });

  it("keeps the name and the schedule setting when neither is given", () => {
    handOverJob({ jobId, template: String(checkinId) });
    const row = jobRow(jobId);
    expect(row.name).toBe("Site signup - 012");
    expect(row.enabled).toBe(0);
  });

  it("puts the job on the schedule when asked, and takes it off again", () => {
    expect(handOverJob({ jobId, template: "Site checkin", enabled: true }).enabled).toBe(true);
    expect(jobRow(jobId).enabled).toBe(1);
    expect(handOverJob({ jobId, template: "Site checkin", enabled: false }).enabled).toBe(false);
    expect(jobRow(jobId).enabled).toBe(0);
  });

  it("takes a template by id as readily as by name, and ignores case", () => {
    expect(handOverJob({ jobId, template: `  ${checkinId}  ` }).templateId).toBe(checkinId);
    expect(handOverJob({ jobId, template: "site CHECKIN" }).templateId).toBe(checkinId);
  });

  it("says so rather than quietly doing nothing when it is already there", () => {
    handOverJob({ jobId, template: "Site checkin" });
    expect(handOverJob({ jobId, template: "Site checkin" }).alreadyLinked).toBe(true);
  });

  it("refuses what it cannot find, leaving the job as it was", () => {
    expect(() => handOverJob({ jobId, template: "Nothing by that name" })).toThrow(/no template/);
    expect(() => handOverJob({ jobId, template: "  " })).toThrow(/no template named/);
    expect(() => handOverJob({ jobId: jobId + 999, template: "Site checkin" })).toThrow(
      /no longer there/,
    );
    expect(jobRow(jobId).template_id).toBe(signupId);
  });
});
