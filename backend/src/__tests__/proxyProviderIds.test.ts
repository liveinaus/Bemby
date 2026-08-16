// Provider ids have to stay unique: they name the proxies a provider imported, and a save
// turns a repeat down. Two ways a repeat used to appear are covered here.
const store = new Map<string, string>();
vi.mock("../db/database", () => ({
  db: {
    prepare: (sql: string) => ({
      get: (key: string) =>
        sql.includes("SELECT") && store.has(key) ? { value: store.get(key) } : undefined,
      run: (key: string, value?: string) => {
        if (sql.startsWith("DELETE")) store.delete(key);
        else store.set(key, value as string);
      },
      all: () => [],
    }),
  },
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readProviders, saveProviders, type ProxyProvider } from "../tg/proxyProviders";

const providers = (): ProxyProvider[] => JSON.parse(store.get("proxy_providers") ?? "[]");

beforeEach(() => store.clear());

describe("readProviders", () => {
  it("adopts the Webshare token that older installs kept on its own", () => {
    store.set("webshare_api_key", "tok");
    expect(readProviders()).toEqual([
      { id: "webshare", name: "Webshare", type: "webshare", apiKey: "tok", enabled: true },
    ]);
  });

  it("clears the token once adopted, so a deleted provider stays deleted", () => {
    store.set("webshare_api_key", "tok");
    readProviders();
    expect(store.has("webshare_api_key")).toBe(false);

    saveProviders([]);
    expect(readProviders()).toEqual([]);
  });

  it("takes a free id when the provider it created has been changed to another type", () => {
    // What a panel reports as "Provider ids must be unique": the row the token created was
    // renamed and repointed at a subscription, so the token was adopted a second time
    store.set(
      "proxy_providers",
      JSON.stringify([
        { id: "webshare", name: "EDT2", type: "subscription", url: "https://w.example", enabled: true },
      ]),
    );
    store.set("webshare_api_key", "tok");

    const got = readProviders();
    expect(got.map((p) => p.id)).toEqual(["webshare", "webshare-2"]);
    expect(got[1]).toMatchObject({ name: "Webshare", type: "webshare", apiKey: "tok" });
  });

  it("heals a list already stored with a repeated id, keeping the first", () => {
    store.set(
      "proxy_providers",
      JSON.stringify([
        { id: "webshare", name: "EDT2", type: "subscription", url: "https://w.example" },
        { id: "webshare", name: "Webshare", type: "webshare", apiKey: "tok" },
      ]),
    );

    expect(readProviders().map((p) => p.name)).toEqual(["EDT2"]);
    expect(providers().map((p) => p.id)).toEqual(["webshare"]);
  });

  it("lets go of a key when the row is pointed at another kind of provider", () => {
    store.set(
      "proxy_providers",
      JSON.stringify([{ id: "a", name: "Webshare", type: "webshare", apiKey: "tok" }]),
    );

    // Same row, now a subscription: a Webshare token is not a credential for that
    const [changed] = saveProviders([
      { id: "a", name: "EDT2", type: "subscription", url: "https://w.example" },
    ]);
    expect(changed.apiKey).toBeUndefined();
  });

  it("keeps a key the client echoed as blank while the type stays put", () => {
    store.set(
      "proxy_providers",
      JSON.stringify([{ id: "a", name: "Webshare", type: "webshare", apiKey: "tok" }]),
    );
    const [kept] = saveProviders([{ id: "a", name: "Renamed", type: "webshare" }]);
    expect(kept.apiKey).toBe("tok");
  });

  it("leaves a list of distinct ids alone, and writes nothing", () => {
    const stored = [
      { id: "a", name: "One", type: "list" as const, url: "https://one.example" },
      { id: "b", name: "Two", type: "webshare" as const, apiKey: "tok" },
    ];
    store.set("proxy_providers", JSON.stringify(stored));
    expect(readProviders()).toEqual(stored);
  });
});
