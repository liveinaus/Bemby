// The msOauth2api client: what it asks the address pool for, and how it reads the answers.

let settings: Record<string, string> = {};

vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((key: string) =>
        sql.includes("settings") && settings[key] !== undefined
          ? { value: settings[key] }
          : undefined,
      ),
      all: vi.fn(() => []),
      run: vi.fn(),
    })),
  },
}));

const undiciFetch = vi.fn();
vi.mock("undici", () => ({ fetch: (...args: unknown[]) => undiciFetch(...args) }));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  leaseEmail,
  maskApiKey,
  msApiConfigured,
  msApiOffReason,
  normaliseBaseUrl,
  pollForCode,
  poolStatus,
  releaseEmail,
  resolvePoolType,
} from "../jobs/msOauth2api";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** The URL the client called, as a parsed URL. */
function calledUrl(call = 0): URL {
  return new URL(String(undiciFetch.mock.calls[call][0]));
}

beforeEach(() => {
  undiciFetch.mockReset();
  process.env.MSOAUTH2API = "1";
  settings = {
    msapi_base_url: "http://pool.example:3000",
    msapi_api_key: "msk_abcdef0123456789",
  };
});

afterEach(() => {
  delete process.env.MSOAUTH2API;
});

// Off at the deployment, nothing about the integration works, whatever is stored
describe("the MSOAUTH2API gate", () => {
  it("reports unconfigured and refuses to call out", async () => {
    delete process.env.MSOAUTH2API;
    expect(msApiConfigured()).toBe(false);
    expect(msApiOffReason()).toMatch(/MSOAUTH2API=1/);
    await expect(poolStatus()).rejects.toThrow(/not enabled on this server/);
    await expect(leaseEmail()).rejects.toThrow(/not enabled on this server/);
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("names the Settings section instead once the deployment offers it", () => {
    settings.msapi_api_key = "";
    expect(msApiConfigured()).toBe(false);
    expect(msApiOffReason()).toMatch(/not configured \(see Settings\)/);
  });
});

describe("normaliseBaseUrl", () => {
  it("drops a trailing slash", () => {
    expect(normaliseBaseUrl("http://host:3000/")).toBe("http://host:3000");
  });

  // The endpoints already carry /api, so pasting it in must not double it up
  it("drops a trailing /api", () => {
    expect(normaliseBaseUrl("http://host:3000/api")).toBe("http://host:3000");
    expect(normaliseBaseUrl("http://host:3000/api/")).toBe("http://host:3000");
  });
});

describe("configuration", () => {
  it("needs both a URL and a key", () => {
    expect(msApiConfigured()).toBe(true);
    settings.msapi_api_key = "";
    expect(msApiConfigured()).toBe(false);
    settings = {};
    expect(msApiConfigured()).toBe(false);
  });

  it("falls back to the default pool type", () => {
    expect(resolvePoolType("")).toBe("Telegram");
    expect(resolvePoolType("Discord")).toBe("Discord");
    settings.msapi_pool_type = "Signup";
    expect(resolvePoolType("")).toBe("Signup");
  });

  it("refuses to call anything without a key", async () => {
    settings.msapi_api_key = "";
    await expect(poolStatus()).rejects.toThrow(/API key/i);
    expect(undiciFetch).not.toHaveBeenCalled();
  });
});

describe("leaseEmail", () => {
  it("sends the key as a header, never in the query", async () => {
    undiciFetch.mockResolvedValue(jsonResponse({ email: "a@b.com" }));
    await leaseEmail("Telegram");

    const url = calledUrl();
    expect(url.pathname).toBe("/api/get-available-email");
    expect(url.searchParams.get("type")).toBe("Telegram");
    expect(url.search).not.toContain("msk_");
    expect(undiciFetch.mock.calls[0][1].headers["X-API-Key"]).toBe(
      "msk_abcdef0123456789",
    );
  });

  // 409 is the pool being empty, which the counts explain -- not a transport failure
  it("reports an exhausted pool with its counts", async () => {
    undiciFetch.mockResolvedValue(
      jsonResponse({ error: "none", available: 0, leased: 3, confirmed: 7 }, 409),
    );
    await expect(leaseEmail("Telegram")).rejects.toThrow(
      /no msOauth2api address left.*available 0, leased 3, confirmed 7/,
    );
  });

  it("names the key when the service rejects it", async () => {
    undiciFetch.mockResolvedValue(jsonResponse({ error: "bad key" }, 401));
    await expect(leaseEmail()).rejects.toThrow(/rejected the API key/);
  });
});

describe("pollForCode", () => {
  it("returns the code once the pool has found one", async () => {
    undiciFetch.mockResolvedValue(
      jsonResponse({
        status: "found",
        code: "483920",
        message: { from: "noreply@telegram.org", subject: "Login code", mailbox: "Junk" },
      }),
    );
    const found = await pollForCode({
      email: "a@b.com",
      type: "Telegram",
      fromContains: "telegram",
      waitMs: 0,
    });
    expect(found).toEqual({
      code: "483920",
      from: "noreply@telegram.org",
      subject: "Login code",
      mailbox: "Junk",
    });
    expect(calledUrl().searchParams.get("from")).toBe("telegram");
  });

  // "pending" is a real answer, so a spent budget gives back null rather than throwing
  it("gives up with null when the wait is over", async () => {
    undiciFetch.mockResolvedValue(jsonResponse({ status: "pending" }));
    expect(await pollForCode({ email: "a@b.com", waitMs: 0 })).toBeNull();
    expect(undiciFetch).toHaveBeenCalledTimes(1);
  });
});

describe("releaseEmail", () => {
  // Releasing is cleanup after a failure; it must never replace the error that caused it
  it("swallows a failure", async () => {
    undiciFetch.mockRejectedValue(new Error("down"));
    await expect(releaseEmail("a@b.com", "Telegram")).resolves.toBeUndefined();
  });
});

describe("maskApiKey", () => {
  it("keeps the ends only", () => {
    expect(maskApiKey("msk_abcdef0123456789")).toBe("msk_ab****6789");
    expect(maskApiKey("short")).toBe("****");
    expect(maskApiKey("")).toBe("");
  });
});

describe("startOauthFlow", () => {
  // The service reads oauth/start from the JSON body, not the query string, so a POST has to
  // carry its params both ways (older endpoints still read the query)
  it("sends the mailbox in the request body", async () => {
    const { startOauthFlow } = await import("../jobs/msOauth2api");
    undiciFetch.mockResolvedValue(
      jsonResponse({ authorizeUrl: "https://login/authorize", redirectUri: "https://cb" }),
    );
    await startOauthFlow("a@b.com");
    const init = undiciFetch.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).email).toBe("a@b.com");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  // msOauth2api keys the mailbox in lower case, so start it the same way or the later status
  // check for the original casing comes back "not stored"
  it("lower-cases the mailbox", async () => {
    const { startOauthFlow } = await import("../jobs/msOauth2api");
    undiciFetch.mockResolvedValue(
      jsonResponse({ authorizeUrl: "https://login/authorize", redirectUri: "https://cb" }),
    );
    await startOauthFlow("Nina_Lewis@Outlook.com");
    expect(JSON.parse(undiciFetch.mock.calls[0][1].body).email).toBe("nina_lewis@outlook.com");
    expect(calledUrl().searchParams.get("email")).toBe("nina_lewis@outlook.com");
  });
});

describe("accountStatus", () => {
  it("queries by the lower-cased mailbox and reads a hit", async () => {
    const { accountStatus } = await import("../jobs/msOauth2api");
    undiciFetch.mockResolvedValue(jsonResponse({ disabled: false, lastRefreshError: null }));
    const st = await accountStatus("Nina_Lewis@Outlook.com");
    expect(calledUrl().searchParams.get("email")).toBe("nina_lewis@outlook.com");
    expect(st.stored).toBe(true);
  });

  it("reads a 404 as not stored", async () => {
    const { accountStatus } = await import("../jobs/msOauth2api");
    undiciFetch.mockResolvedValue(jsonResponse({ error: "no account" }, 404));
    expect((await accountStatus("a@b.com")).stored).toBe(false);
  });
});
