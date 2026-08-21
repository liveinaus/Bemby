// The SSRF guard decides whether the server may be pointed at an address, so the ranges it
// refuses are a security boundary rather than a detail. Every case here is one that reaches
// something internal if it is let through.

import { describe, it, expect, vi, afterEach } from "vitest";
import { isBlockedIp, assertPublicUrl, headersAllowFraming } from "../tg/safeFetch";

/** The allowlist is read once at import, so each case needs its own module instance. */
async function withAllowedRanges(value: string) {
  vi.resetModules();
  process.env.SSRF_ALLOWED_IP_RANGES = value;
  return await import("../tg/safeFetch");
}

describe("isBlockedIp -- IPv4", () => {
  it("blocks loopback, RFC1918 and link-local", () => {
    for (const ip of [
      "0.0.0.0",
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks carrier-grade NAT, benchmarking, documentation and multicast ranges", () => {
    for (const ip of [
      "100.64.0.1",
      "100.127.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe("isBlockedIp -- IPv6", () => {
  it("blocks loopback, unspecified, unique-local, link-local and multicast", () => {
    for (const ip of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks an IPv4-mapped private address in either notation", () => {
    // The same address written two ways; a prefix-matching check sees only one of them
    for (const ip of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "0:0:0:0:0:ffff:127.0.0.1",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks a private destination behind the NAT64 prefix", () => {
    expect(isBlockedIp("64:ff9b::127.0.0.1")).toBe(true);
    expect(isBlockedIp("64:ff9b::192.168.0.1")).toBe(true);
  });

  it("allows ordinary public addresses, mapped ones included", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedIp("::ffff:1.1.1.1")).toBe(false);
    expect(isBlockedIp("64:ff9b::8.8.8.8")).toBe(false);
  });

  it("rejects anything that is not an address at all", () => {
    for (const value of ["", "not-an-ip", "999.1.1.1", "::gggg"]) {
      expect(isBlockedIp(value), value).toBe(true);
    }
  });
});

describe("assertPublicUrl", () => {
  it("refuses a non-http scheme", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http/i);
    await expect(assertPublicUrl("gopher://example.com/")).rejects.toThrow(/http/i);
  });

  it("refuses a private IP literal", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:3000/")).rejects.toThrow(/private/i);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private/i);
  });

  it("refuses a bracketed IPv6 literal that maps to loopback", async () => {
    await expect(assertPublicUrl("http://[::ffff:127.0.0.1]:3000/")).rejects.toThrow(/private/i);
    await expect(assertPublicUrl("http://[::1]:3000/")).rejects.toThrow(/private/i);
  });

  it("accepts a public IP literal", async () => {
    await expect(assertPublicUrl("https://1.1.1.1/")).resolves.toBeUndefined();
  });

  it("refuses a name that resolves to loopback", async () => {
    // localhost resolves to 127.0.0.1 and/or ::1 on every platform this runs on
    await expect(assertPublicUrl("http://localhost:3000/")).rejects.toThrow(/private/i);
  });

  it("names the host and what it resolved to, so the operator can see why", async () => {
    await expect(assertPublicUrl("http://localhost:3000/")).rejects.toThrow(/localhost resolves to/);
    await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toThrow(/127\.0\.0\.1/);
  });
});

// A transparent proxy in fake-ip mode answers every name with a placeholder from a reserved
// range, so the guard's premise -- that the resolved address is where the bytes go -- does
// not hold and the operator has to be able to say so.
describe("SSRF_ALLOWED_IP_RANGES", () => {
  const original = process.env.SSRF_ALLOWED_IP_RANGES;

  afterEach(() => {
    if (original === undefined) delete process.env.SSRF_ALLOWED_IP_RANGES;
    else process.env.SSRF_ALLOWED_IP_RANGES = original;
    vi.resetModules();
  });

  it("allows a named range, and nothing outside it", async () => {
    const mod = await withAllowedRanges("198.18.0.0/15");
    expect(mod.isBlockedIp("198.18.0.5")).toBe(false);
    expect(mod.isBlockedIp("198.19.255.254")).toBe(false);
    // The private space that naming a range must not open up
    expect(mod.isBlockedIp("127.0.0.1")).toBe(true);
    expect(mod.isBlockedIp("192.168.1.1")).toBe(true);
    expect(mod.isBlockedIp("169.254.169.254")).toBe(true);
    expect(mod.isBlockedIp("198.51.100.1")).toBe(true);
  });

  it("stops at the prefix, on a range whose neighbours are blocked either way", async () => {
    // Loopback only because it is the one place a mask can be seen working: an address just
    // outside a /24 stays blocked. Not a range anyone should actually name.
    const mod = await withAllowedRanges("127.0.0.0/24");
    expect(mod.isBlockedIp("127.0.0.9")).toBe(false);
    expect(mod.isBlockedIp("127.0.1.9")).toBe(true);
  });

  it("reads an IPv4-mapped form as the IPv4 it carries", async () => {
    const mod = await withAllowedRanges("28.0.0.0/8");
    expect(mod.isBlockedIp("28.1.2.3")).toBe(false);
    expect(mod.isBlockedIp("::ffff:28.1.2.3")).toBe(false);
    expect(mod.isBlockedIp("::ffff:127.0.0.1")).toBe(true);
  });

  it("takes several ranges, and ignores an entry that is not a CIDR", async () => {
    const mod = await withAllowedRanges("198.18.0.0/15, fd00::/8, not-an-address");
    expect(mod.isBlockedIp("198.18.0.5")).toBe(false);
    expect(mod.isBlockedIp("fd12::1")).toBe(false);
    expect(mod.isBlockedIp("fe80::1")).toBe(true);
  });

  it("changes nothing when unset", async () => {
    const mod = await withAllowedRanges("");
    expect(mod.isBlockedIp("198.18.0.5")).toBe(true);
    expect(mod.isBlockedIp("1.1.1.1")).toBe(false);
  });
});

describe("headersAllowFraming", () => {
  it("refuses on X-Frame-Options", () => {
    expect(headersAllowFraming(new Headers({ "x-frame-options": "DENY" }))).toBe(false);
    expect(headersAllowFraming(new Headers({ "x-frame-options": "SAMEORIGIN" }))).toBe(false);
  });

  it("refuses on a frame-ancestors that is not a wildcard", () => {
    expect(
      headersAllowFraming(new Headers({ "content-security-policy": "frame-ancestors 'self'" })),
    ).toBe(false);
  });

  it("allows a wildcard frame-ancestors, and headers that say nothing", () => {
    expect(
      headersAllowFraming(new Headers({ "content-security-policy": "frame-ancestors *" })),
    ).toBe(true);
    expect(headersAllowFraming(new Headers())).toBe(true);
  });
});
