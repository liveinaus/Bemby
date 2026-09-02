// Which exit a job leaves by, as the optional column on the jobs page reports it. The chain
// (a browser step's own pick, then the job, then its template, then the account) and how a
// pool is named are what this pins down: a pool must never be listed out, and a pick that
// overrides the account has to keep saying that Telegram still follows the account's own
// proxy.

import Database from "better-sqlite3";

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
  getDefaultTgApiCredentials: () => null,
}));

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { makeJobProxyResolver } from "../jobs/jobProxy";

const SCHEMA = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE job_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, config TEXT);
`;

const PROXIES = [
  { id: "p1", name: "Sydney", url: "socks5://user:pw@1.1.1.1:1080" },
  // No name: the exit has to be identified by host and port, never by its url
  { id: "p2", name: "", url: "http://user:pw@2.2.2.2:8080" },
  { id: "pp:acme:1", name: "acme-1", url: "http://3.3.3.3:80" },
  { id: "pp:acme:2", name: "acme-2", url: "http://4.4.4.4:80" },
];

const PROVIDERS = [{ id: "acme", name: "Acme Proxies", type: "list", enabled: true }];

function setting(key: string, value: unknown): void {
  testDb
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(key, JSON.stringify(value));
}

function addTemplate(config: unknown): number {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO job_templates (config) VALUES (?)")
    .run(JSON.stringify(config));
  return Number(lastInsertRowid);
}

function row(over: Partial<Parameters<ReturnType<typeof makeJobProxyResolver>>[0]> = {}) {
  return { config: null, template_id: null, account_proxy_id: null, ...over };
}

const cfg = (proxyId: string, proxyPool?: string[]) =>
  JSON.stringify({ proxyId, ...(proxyPool ? { proxyPool } : {}) });

/** A custom job's config: its own proxy pick, where it has one, and its action chain. */
const chain = (actions: unknown[], proxyId?: string) =>
  JSON.stringify({ ...(proxyId ? { proxyId } : {}), actions });

const openUrl = (proxyId?: string, proxyPool?: string[]) => ({
  type: "open_url",
  url: "https://example.com",
  ...(proxyId ? { proxyId } : {}),
  ...(proxyPool ? { proxyPool } : {}),
});

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  testDb.exec("DELETE FROM settings; DELETE FROM job_templates;");
  setting("proxies", PROXIES);
  setting("proxy_providers", PROVIDERS);
});

describe("makeJobProxyResolver", () => {
  it("follows the account's proxy when neither job nor template picks one", () => {
    const resolve = makeJobProxyResolver();
    expect(resolve(row({ account_proxy_id: "p1" }))).toEqual({
      kind: "proxy",
      label: "Sydney",
      source: "account",
    });
  });

  it("flags an exit that has been deleted, since its id reads like a name", () => {
    const resolve = makeJobProxyResolver();
    // What the jobs page showed for this was a bare id in the proxy column, which looks
    // exactly like a configured exit with an odd name -- the account appeared to have a
    // proxy nobody had set.
    expect(resolve(row({ account_proxy_id: "gone" }))).toEqual({
      kind: "proxy",
      label: "gone",
      source: "account",
      missing: true,
    });
  });

  it("flags the account's deleted exit apart from the job's own working one", () => {
    const resolve = makeJobProxyResolver();
    const result = resolve(row({ config: cfg("p1"), account_proxy_id: "gone" }));

    // The job's browser exit is fine; it is Telegram's that has gone, and they are set on
    // different pages, so one flag must not stand in for the other.
    expect(result).toMatchObject({
      kind: "proxy",
      label: "Sydney",
      source: "job",
      tgLabel: "gone",
      tgMissing: true,
    });
    expect(result.missing).toBeUndefined();
  });

  it("reads direct as direct, whether it is unset or picked outright", () => {
    const resolve = makeJobProxyResolver();
    expect(resolve(row())).toEqual({ kind: "direct", label: "", source: "account" });
    expect(resolve(row({ config: cfg("direct"), account_proxy_id: "p1" }))).toMatchObject({
      kind: "direct",
      source: "job",
    });
  });

  it("names an unnamed exit by host and port, never by its url", () => {
    const resolve = makeJobProxyResolver();
    expect(resolve(row({ account_proxy_id: "p2" })).label).toBe("2.2.2.2:8080");
  });

  it("lets the job's pick beat the template's, and the template's beat the account's", () => {
    const template = addTemplate({ proxyId: "pp:acme:1" });
    const resolve = makeJobProxyResolver();

    expect(
      resolve(row({ config: cfg("p1"), template_id: template, account_proxy_id: "p2" })),
    ).toMatchObject({ label: "Sydney", source: "job" });
    expect(
      resolve(row({ template_id: template, account_proxy_id: "p2" })),
    ).toMatchObject({ label: "acme-1", source: "template" });
  });

  it("says the Telegram side still follows the account when the job overrides it", () => {
    const resolve = makeJobProxyResolver();
    const overridden = resolve(row({ config: cfg("p1"), account_proxy_id: "p2" }));
    expect(overridden.tgLabel).toBe("2.2.2.2:8080");

    // Nothing to say when the pick and the account agree, or when there is no account proxy
    expect(resolve(row({ config: cfg("p1"), account_proxy_id: "p1" })).tgLabel).toBeUndefined();
    expect(resolve(row({ config: cfg("p1") })).tgLabel).toBeUndefined();
  });

  it("names a whole-supplier pool by the supplier rather than listing its exits", () => {
    const resolve = makeJobProxyResolver();
    expect(resolve(row({ config: cfg("random", ["provider:acme"]) }))).toEqual({
      kind: "provider",
      label: "Acme Proxies",
      source: "job",
      poolSize: 2,
    });
  });

  it("counts any other draw instead of naming it", () => {
    const resolve = makeJobProxyResolver();
    // A hand-picked pool
    expect(resolve(row({ config: cfg("random", ["p1", "p2"]) }))).toEqual({
      kind: "random",
      label: "",
      source: "job",
      poolSize: 2,
    });
    // A supplier mixed with a loose exit is not that supplier
    expect(
      resolve(row({ config: cfg("random", ["provider:acme", "p1"]) })),
    ).toMatchObject({ kind: "random", poolSize: 3 });
    // No pool at all draws from the whole list
    expect(resolve(row({ config: cfg("random") }))).toMatchObject({
      kind: "random",
      poolSize: 4,
    });
  });

  it("still names a pin whose exit has since been removed from the list", () => {
    const resolve = makeJobProxyResolver();
    expect(resolve(row({ account_proxy_id: "gone" }))).toMatchObject({
      kind: "proxy",
      label: "gone",
    });
  });

  it("reads a config stored as JSON of a JSON string, as some rows hold it", () => {
    const resolve = makeJobProxyResolver();
    expect(resolve(row({ config: JSON.stringify(cfg("p1")) }))).toMatchObject({
      label: "Sydney",
      source: "job",
    });
  });

  // A custom job with no template has no proxy picker of its own: the exit is set on the
  // step. The column used to answer with the account's proxy, which such a job's browser
  // never leaves by.
  it("takes a browser step's own pick over the account's proxy", () => {
    const resolve = makeJobProxyResolver();
    const result = resolve(
      row({ config: chain([openUrl("p1")]), account_proxy_id: "p2" }),
    );
    expect(result).toMatchObject({ kind: "proxy", label: "Sydney", source: "action" });
    // Telegram is still dialled on the account's exit, even by a job that only opens a page
    expect(result.tgLabel).toBe("2.2.2.2:8080");
    expect(result.stepsDiffer).toBeUndefined();
  });

  it("names a step's draw the same way a job's is named", () => {
    const resolve = makeJobProxyResolver();
    expect(
      resolve(row({ config: chain([openUrl("random", ["provider:acme"])]) })),
    ).toEqual({ kind: "provider", label: "Acme Proxies", source: "action", poolSize: 2 });
  });

  it("follows the job's pick for a step left blank, and the account's for both blank", () => {
    const resolve = makeJobProxyResolver();
    expect(
      resolve(row({ config: chain([openUrl()], "p1"), account_proxy_id: "p2" })),
    ).toMatchObject({ label: "Sydney", source: "job" });
    // Nothing picked anywhere: the browser falls back to the account's exit, so it is the
    // answer here too
    expect(
      resolve(row({ config: chain([openUrl()]), account_proxy_id: "p2" })),
    ).toMatchObject({ label: "2.2.2.2:8080", source: "account" });
  });

  it("flags steps that leave by different exits rather than picking one for them", () => {
    const resolve = makeJobProxyResolver();
    const result = resolve(
      row({ config: chain([openUrl("p1"), openUrl("p2")]), account_proxy_id: "p1" }),
    );
    expect(result).toMatchObject({ label: "Sydney", source: "action", stepsDiffer: true });
  });

  it("counts a browser step inside a check's arm", () => {
    const resolve = makeJobProxyResolver();
    const config = chain([
      {
        type: "if_check",
        check: "last_action",
        then: [openUrl("p1")],
        otherwise: [{ type: "end_job" }],
      },
    ]);
    expect(resolve(row({ config, account_proxy_id: "p2" }))).toMatchObject({
      label: "Sydney",
      source: "action",
    });
  });

  it("leaves a chain that opens no browser on the account's exit", () => {
    const resolve = makeJobProxyResolver();
    const config = chain([
      { type: "send_command", content: "/checkin", proxyId: "p1" },
      { type: "wait_reply", maxWaitMs: 1000 },
    ]);
    // The stray proxyId on a Telegram step is not an exit: nothing about that step goes
    // out through anything but the account's own proxy
    expect(resolve(row({ config, account_proxy_id: "p2" }))).toMatchObject({
      label: "2.2.2.2:8080",
      source: "account",
    });
  });

  it("reads each template once however many jobs point at it", () => {
    const template = addTemplate({ proxyId: "p1" });
    const resolve = makeJobProxyResolver();
    const spy = vi.spyOn(testDb, "prepare");
    for (let i = 0; i < 5; i++) resolve(row({ template_id: template }));
    const templateReads = spy.mock.calls.filter((c) =>
      String(c[0]).includes("FROM job_templates"),
    );
    expect(templateReads).toHaveLength(1);
    spy.mockRestore();
  });
});
