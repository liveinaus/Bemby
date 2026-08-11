// A bulk run can carry a hundred handles typed or generated elsewhere. Telegram refuses a
// bad one per account, mid-batch, after the gap has already been spent -- so the rules are
// checked here first, and the message has to say which rule was broken.

import { describe, it, expect } from "vitest";
import { isValidUsername, normaliseUsername, usernameError } from "../tg/usernames";

describe("normaliseUsername", () => {
  it("accepts the @ people paste along with the handle", () => {
    expect(normaliseUsername("@luna_04")).toBe("luna_04");
    expect(normaliseUsername("  @@luna_04  ")).toBe("luna_04");
  });

  it("leaves an already-bare handle alone", () => {
    expect(normaliseUsername("luna_04")).toBe("luna_04");
  });
});

describe("usernameError", () => {
  it("passes handles Telegram accepts", () => {
    for (const name of ["luna1", "a_b_c_d", "User_2026", "a".repeat(32)]) {
      expect(usernameError(name)).toBeNull();
    }
  });

  it("names the rule that was broken", () => {
    expect(usernameError("")).toMatch(/empty/i);
    expect(usernameError("abc")).toMatch(/at least 5/);
    expect(usernameError("a".repeat(33))).toMatch(/at most 32/);
    expect(usernameError("1luna")).toMatch(/start with a letter/);
    expect(usernameError("_luna")).toMatch(/start with a letter/);
    expect(usernameError("luna-04")).toMatch(/letters, digits and underscores/);
    expect(usernameError("luna 04")).toMatch(/letters, digits and underscores/);
  });

  it("judges the handle, not the @ in front of it", () => {
    expect(usernameError("@luna1")).toBeNull();
    expect(usernameError("@abc")).toMatch(/at least 5/);
  });
});

describe("isValidUsername", () => {
  it("agrees with usernameError", () => {
    expect(isValidUsername("luna_04")).toBe(true);
    expect(isValidUsername("no")).toBe(false);
  });
});
