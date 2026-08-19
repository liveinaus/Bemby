// Which exit a job leaves by, as the optional column on the jobs page reports it. The chain
// (job, then template, then account) and how a pool is named are what this pins down: a pool
// must never be listed out, and a pick that overrides the account has to keep saying that
// Telegram still follows the account's own proxy.

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
