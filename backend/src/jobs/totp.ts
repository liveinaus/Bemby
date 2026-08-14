// The code an authenticator app would be showing, worked out from the shared secret a site
// handed over when two-factor authentication was switched on. Kept in a module of its own so
// the page step and its tests can reach it without pulling in a browser.

import { createHmac } from "node:crypto";

/** How long a code must still have left before the step will hand it on, when not told. */
export const TOTP_MIN_VALID_MS = 10_000;

export type TotpSpec = {
  /** The shared secret, decoded from base32. */
  secret: Buffer;
  /** Digits the site expects, normally 6. */
  digits: number;
  /** How long each code lasts, normally 30s. */
  periodMs: number;
  /** Digest the code is derived with, as node names it. */
  algorithm: "sha1" | "sha256" | "sha512";
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decodes the base32 an authenticator secret is written in. Spaces, dashes and lower case are
 * all fine: a secret copied off a setup page usually arrives in groups of four.
 */
export function decodeBase32(text: string): Buffer {
  const clean = text.replace(/[\s-]+/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean) throw new Error("the authenticator secret is empty");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error(`\`${ch}\` is not part of a base32 secret`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  if (!bytes.length) throw new Error("the authenticator secret is too short to hold a byte");
  return Buffer.from(bytes);
}

function digestFor(name: string): TotpSpec["algorithm"] {
  switch (name.trim().toUpperCase()) {
    case "":
    case "SHA1":
      return "sha1";
    case "SHA256":
      return "sha256";
    case "SHA512":
      return "sha512";
    default:
      throw new Error(
        `\`${name}\` is not a digest a code can be worked out with`,
      );
  }
}

/**
 * Reads a secret the way it was given: the whole `otpauth://` URL, which carries the digit
 * count and the step length with it, or the base32 secret on its own with the usual defaults.
 */
export function parseTotpSecret(raw: string): TotpSpec {
  const text = raw.trim();
  if (!text) throw new Error("no authenticator secret given");
  if (!/^otpauth:\/\//i.test(text)) {
    return { secret: decodeBase32(text), digits: 6, periodMs: 30_000, algorithm: "sha1" };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("the otpauth:// address could not be read");
  }
  // hostname is the type, e.g. `totp` in otpauth://totp/Issuer:name. A counter-based code
  // needs a counter kept somewhere, which no page step has anywhere to put.
  const kind = (url.hostname || url.pathname.split("/")[0] || "").toLowerCase();
  if (kind && kind !== "totp") {
    throw new Error(`only otpauth://totp secrets work here, not \`${kind}\``);
  }
  const secret = url.searchParams.get("secret") ?? "";
  if (!secret) throw new Error("the otpauth:// address carries no `secret`");
  const digits = Number(url.searchParams.get("digits") ?? 6);
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) {
    throw new Error(`\`${url.searchParams.get("digits")}\` is not a length a code comes in`);
  }
  const period = Number(url.searchParams.get("period") ?? 30);
  if (!Number.isFinite(period) || period <= 0) {
    throw new Error(`\`${url.searchParams.get("period")}\` is not how long a code lasts`);
  }
  return {
    secret: decodeBase32(secret),
    digits,
    periodMs: Math.round(period * 1000),
    algorithm: digestFor(url.searchParams.get("algorithm") ?? ""),
  };
}

/** How long the code covering `atMs` still has before its window turns over. */
export function totpMsLeft(spec: TotpSpec, atMs: number): number {
  return spec.periodMs - (atMs % spec.periodMs);
}

/** The code for the window `atMs` falls in, zero-padded to the length the site expects. */
export function totpCode(spec: TotpSpec, atMs: number): string {
  const counter = Math.floor(atMs / spec.periodMs);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac(spec.algorithm, spec.secret).update(message).digest();
  // RFC 4226 dynamic truncation: the low nibble of the last byte says where to read from
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** spec.digits).padStart(spec.digits, "0");
}
