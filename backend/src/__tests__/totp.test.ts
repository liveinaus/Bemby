import { describe, it, expect } from "vitest";
import {
  decodeBase32,
  findOtpSecret,
  maskOtpSecret,
  parseTotpSecret,
  totpCode,
  totpMsLeft,
} from "../jobs/totp";

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("decodeBase32", () => {
  it("reads a secret however it was copied", () => {
    const plain = decodeBase32("JBSWY3DPEHPK3PXP");
    expect(plain.toString("hex")).toBe("48656c6c6f21deadbeef");
    // Grouped, lower case and padded all give the same bytes
    expect(decodeBase32("jbsw y3dp ehpk 3pxp").equals(plain)).toBe(true);
    expect(decodeBase32("JBSWY3DP-EHPK3PXP").equals(plain)).toBe(true);
    expect(decodeBase32("JBSWY3DPEHPK3PXP===").equals(plain)).toBe(true);
  });

  it("refuses what is not base32", () => {
    expect(() => decodeBase32("")).toThrow(/empty/);
    expect(() => decodeBase32("nope!")).toThrow(/base32/);
    // 1, 8 and 9 are not in the alphabet, which is what catches a mistyped secret
    expect(() => decodeBase32("ABCD1234")).toThrow(/base32/);
  });
});

describe("parseTotpSecret", () => {
  it("takes the digit count and the step length off an otpauth URL", () => {
    const spec = parseTotpSecret(
      `otpauth://totp/Example:me?secret=${RFC_SECRET}` +
        `&issuer=Example&digits=8&period=60&algorithm=SHA256`,
    );
    expect(spec.digits).toBe(8);
    expect(spec.periodMs).toBe(60_000);
    expect(spec.algorithm).toBe("sha256");
  });

  it("falls back to the usual defaults for a bare secret", () => {
    const spec = parseTotpSecret(` ${RFC_SECRET} `);
    expect(spec.digits).toBe(6);
    expect(spec.periodMs).toBe(30_000);
    expect(spec.algorithm).toBe("sha1");
  });

  it("says what is wrong rather than working out a code from nothing", () => {
    expect(() => parseTotpSecret("")).toThrow(/no authenticator secret/);
    expect(() => parseTotpSecret("otpauth://totp/Example:me?issuer=Example")).toThrow(
      /no `secret`/,
    );
    // A counter-based code needs a counter kept somewhere, which no page step has
    expect(() => parseTotpSecret(`otpauth://hotp/Example:me?secret=${RFC_SECRET}`)).toThrow(
      /totp/,
    );
    expect(() => parseTotpSecret(`otpauth://totp/x?secret=${RFC_SECRET}&digits=99`)).toThrow(
      /not a length/,
    );
    expect(() => parseTotpSecret(`otpauth://totp/x?secret=${RFC_SECRET}&algorithm=MD5`)).toThrow(
      /digest/,
    );
  });
});

describe("totpCode", () => {
  // RFC 6238 appendix B, the SHA-1 rows
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    // Past 2^31 seconds, which is where a counter kept in a 32-bit int goes wrong
    [20000000000, "65353130"],
  ])("matches the published vector at T=%i", (seconds, expected) => {
    const spec = {
      secret: decodeBase32(RFC_SECRET),
      digits: 8,
      periodMs: 30_000,
      algorithm: "sha1" as const,
    };
    expect(totpCode(spec, seconds * 1000)).toBe(expected);
  });

  it("holds steady across a window and turns over at its edge", () => {
    const spec = parseTotpSecret(RFC_SECRET);
    expect(totpCode(spec, 60_000)).toBe(totpCode(spec, 89_999));
    expect(totpCode(spec, 90_000)).not.toBe(totpCode(spec, 89_999));
  });

  it("pads a code that came out short", () => {
    const spec = parseTotpSecret(RFC_SECRET);
    for (let t = 0; t < 200; t++) {
      expect(totpCode(spec, t * 30_000)).toMatch(/^\d{6}$/);
    }
  });
});

describe("totpMsLeft", () => {
  it("counts down to the turnover, never to zero", () => {
    const spec = parseTotpSecret(RFC_SECRET);
    expect(totpMsLeft(spec, 60_000)).toBe(30_000);
    expect(totpMsLeft(spec, 75_000)).toBe(15_000);
    expect(totpMsLeft(spec, 89_999)).toBe(1);
  });
});

describe("findOtpSecret", () => {
  const URL_SECRET = `otpauth://totp/Example:someone?secret=${RFC_SECRET}&issuer=Example`;

  it("prefers a whole otpauth URL wherever it turns up", () => {
    // An href, a data- attribute, and the encoded copy inside a QR service's address
    expect(findOtpSecret(["nothing here", URL_SECRET])).toBe(URL_SECRET);
    expect(findOtpSecret([`  ${URL_SECRET}  `])).toBe(URL_SECRET);
    expect(findOtpSecret([`https://qr.example/?size=200&data=${URL_SECRET}`])).toBe(URL_SECRET);
    // Taken over a bare secret printed on the same page
    expect(findOtpSecret([RFC_SECRET, URL_SECRET])).toBe(URL_SECRET);
  });

  it("ignores an otpauth URL that carries no secret", () => {
    expect(findOtpSecret(["otpauth://totp/Example:someone?issuer=Example"])).toBeUndefined();
  });

  it("falls back to the secret a page prints for whoever cannot scan", () => {
    expect(findOtpSecret([`Manual entry: ${RFC_SECRET}`])).toBe(RFC_SECRET);
    // Grouped in fours, as a setup page usually shows it
    expect(findOtpSecret(["密钥：GEZD GNBV GY3T QOJQ"])).toBe("GEZDGNBVGY3TQOJQ");
  });

  it("does not read ordinary capitals as a secret", () => {
    expect(findOtpSecret(["TWO FACTOR AUTHENTICATION IS NOW ON"])).toBeUndefined();
    // Too short to be one anybody issues
    expect(findOtpSecret(["ABCDEFGH"])).toBeUndefined();
    // 1, 8 and 9 are not in the alphabet
    expect(findOtpSecret(["SCAN THE QR CODE WITH GOOGLE AUTH 189"])).toBeUndefined();
    expect(findOtpSecret([])).toBeUndefined();
  });

  it("finds a secret that would work, so the code after it is real", () => {
    const found = findOtpSecret([`Secret: ${RFC_SECRET}`]);
    expect(totpCode(parseTotpSecret(found!), 59_000)).toBe("287082");
  });
});

describe("maskOtpSecret", () => {
  it("keeps the label and drops the secret", () => {
    const masked = maskOtpSecret(
      `otpauth://totp/Example:someone?secret=${RFC_SECRET}&issuer=Example`,
    );
    expect(masked).toBe("otpauth://totp/Example:someone?secret=…&issuer=Example");
    expect(masked).not.toContain(RFC_SECRET);
  });

  it("says only how long a bare secret was", () => {
    const masked = maskOtpSecret(RFC_SECRET);
    expect(masked).toBe("GEZD… (32 characters)");
    expect(masked).not.toContain(RFC_SECRET);
  });
});

describe("findOtpSecret, on what a page actually holds", () => {
  it("never returns a fragment of an encoded otpauth URL", () => {
    // The url-decoded copy is what the scan hands over beside it; on its own the encoded one is
    // no place to look for a loose base32 run
    const encoded = `https://qr.example/?data=otpauth%3A%2F%2Ftotp%2FExample%3Fsecret%3D${RFC_SECRET}`;
    expect(findOtpSecret([encoded])).toBeUndefined();
    expect(findOtpSecret([encoded, decodeURIComponent(encoded)])).toContain("otpauth://totp/");
  });
});
