// vi.mock calls are hoisted before imports, preventing the DB from opening
vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));

import { describe, it, expect, vi } from "vitest";
import {
  expandCommand,
  isAiBtn,
  parseAiBtnHint,
  hasAiInput,
  hasAiInputHint,
  parseAiInputHint,
  parseAiInputLength,
  buildAiInputPrompt,
  buildCaptchaPrompt,
  htmlToText,
} from "../jobs/checkin";

// ---------------------------------------------------------------------------
// expandCommand
// ---------------------------------------------------------------------------

describe("expandCommand", () => {
  it("returns the template unchanged when there are no placeholders", () => {
    expect(expandCommand("/checkin")).toBe("/checkin");
    expect(expandCommand("/start")).toBe("/start");
  });

  it("{word} produces 6 lowercase letters by default", () => {
    const result = expandCommand("{word}");
    expect(result).toMatch(/^[a-z]{6}$/);
  });

  it("{word:N} respects the custom length", () => {
    expect(expandCommand("{word:4}")).toMatch(/^[a-z]{4}$/);
    expect(expandCommand("{word:10}")).toMatch(/^[a-z]{10}$/);
  });

  it("{WORD} produces 6 uppercase letters by default", () => {
    expect(expandCommand("{WORD}")).toMatch(/^[A-Z]{6}$/);
  });

  it("{WORD:N} respects the custom length", () => {
    expect(expandCommand("{WORD:3}")).toMatch(/^[A-Z]{3}$/);
  });

  it("{num} produces 6 digits by default", () => {
    expect(expandCommand("{num}")).toMatch(/^\d{6}$/);
  });

  it("{num:N} respects the custom length", () => {
    expect(expandCommand("{num:4}")).toMatch(/^\d{4}$/);
  });

  it("{num:low-high} stays inside the range, both bounds included", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const got = expandCommand("{num:1-30}");
      expect(got).toMatch(/^\d{1,2}$/);
      const n = Number(got);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(30);
      seen.add(got);
    }
    // Both ends come up: an off-by-one at either would show here
    expect(seen.has("1")).toBe(true);
    expect(seen.has("30")).toBe(true);
  });

  it("a leading zero pads the range to a fixed width", () => {
    for (let i = 0; i < 100; i++) {
      const got = expandCommand("{num:01-30}");
      expect(got).toMatch(/^\d{2}$/);
      expect(Number(got)).toBeGreaterThanOrEqual(1);
      expect(Number(got)).toBeLessThanOrEqual(30);
    }
    expect(expandCommand("{num:0001-9}")).toMatch(/^000\d$/);
  });

  it("a lone zero bound is a bound, not a request to pad", () => {
    const got = new Set(Array.from({ length: 100 }, () => expandCommand("{num:0-9}")));
    expect([...got].every((v) => /^\d$/.test(v))).toBe(true);
    expect(got.has("0")).toBe(true);
  });

  it("bounds either way round mean the same range", () => {
    for (let i = 0; i < 50; i++) {
      const n = Number(expandCommand("{num:30-1}"));
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(30);
    }
  });

  it("a single-value range always gives that value", () => {
    expect(expandCommand("{num:7-7}")).toBe("7");
    expect(expandCommand("{num:07-07}")).toBe("07");
  });

  it("a range reads as a range only for num, and never as a length", () => {
    expect(expandCommand("{word:1-3}")).toBe("{word:1-3}");
    expect(expandCommand("{alpha:2-4}")).toBe("{alpha:2-4}");
    // Bounds past a safe integer are no range at all, and must not be read as a length either
    expect(expandCommand("{num:99999999999999999999-1}")).toBe(
      "{num:99999999999999999999-1}",
    );
  });

  it("a plain length is capped rather than allocating whatever was typed", () => {
    expect(expandCommand("{num:999999999}")).toHaveLength(4096);
  });

  it("mixes a range with the other placeholders in one string", () => {
    expect(expandCommand("day-{num:01-31} {word:3}")).toMatch(/^day-\d{2} [a-z]{3}$/);
  });

  it("{alpha} produces 8 alphanumeric characters by default", () => {
    expect(expandCommand("{alpha}")).toMatch(/^[a-zA-Z0-9]{8}$/);
  });

  it("{alpha:N} respects the custom length", () => {
    expect(expandCommand("{alpha:5}")).toMatch(/^[a-zA-Z0-9]{5}$/);
  });

  it("{uuid} produces a valid RFC 4122 v4 UUID", () => {
    const uuid = expandCommand("{uuid}");
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("UUID version and variant bits are always correct across multiple calls", () => {
    for (let i = 0; i < 20; i++) {
      const uuid = expandCommand("{uuid}");
      // version nibble must be 4
      expect(uuid[14]).toBe("4");
      // variant nibble must be 8, 9, a, or b
      expect(["8", "9", "a", "b"]).toContain(uuid[19]);
    }
  });

  it("{randomFirstName} and {randomLastName} produce an ordinary name", () => {
    expect(expandCommand("{randomFirstName}")).toMatch(/^[A-Z][a-z]+$/);
    expect(expandCommand("{randomLastName}")).toMatch(/^[A-Z][a-z]+$/);
    expect(expandCommand("{randomFirstName} {randomLastName}")).toMatch(
      /^[A-Z][a-z]+ [A-Z][a-z]+$/,
    );
  });

  it("draws a different name often enough to be random", () => {
    const seen = new Set(
      Array.from({ length: 40 }, () => expandCommand("{randomFirstName}")),
    );
    expect(seen.size).toBeGreaterThan(5);
  });

  it("a name placeholder ignores a length, having no use for one", () => {
    expect(expandCommand("{randomFirstName:4}")).toMatch(/^[A-Z][a-z]+$/);
  });

  it("a named context value still wins over a random name", () => {
    expect(expandCommand("{randomFirstName}", { randomFirstName: "Sam" })).toBe("Sam");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(expandCommand("{foo}")).toBe("{foo}");
    expect(expandCommand("{bar:5}")).toBe("{bar:5}");
  });

  it("expands multiple placeholders in one string", () => {
    const result = expandCommand("/code {num:4}-{word:3}");
    expect(result).toMatch(/^\/code \d{4}-[a-z]{3}$/);
  });

  it("expands known placeholders while leaving unknown ones", () => {
    const result = expandCommand("{word} {unknown}");
    expect(result).toMatch(/^[a-z]{6} \{unknown\}$/);
  });
});

// ---------------------------------------------------------------------------
// isAiBtn
// ---------------------------------------------------------------------------

describe("isAiBtn", () => {
  it("recognises the bare placeholder", () => {
    expect(isAiBtn("{aiBtn}")).toBe(true);
  });

  it("recognises a placeholder with a hint", () => {
    expect(isAiBtn("{aiBtn:sign in}")).toBe(true);
    expect(isAiBtn("{aiBtn:click the check-in button}")).toBe(true);
  });

  it("rejects a placeholder with an empty hint", () => {
    expect(isAiBtn("{aiBtn:}")).toBe(false);
  });

  it("rejects plain button text", () => {
    expect(isAiBtn("签到")).toBe(false);
    expect(isAiBtn("Check In")).toBe(false);
  });

  it("rejects other placeholders", () => {
    expect(isAiBtn("{anyBtn}")).toBe(false);
    expect(isAiBtn("{word}")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isAiBtn("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAiBtnHint
// ---------------------------------------------------------------------------

describe("parseAiBtnHint", () => {
  it("returns undefined for the bare placeholder", () => {
    expect(parseAiBtnHint("{aiBtn}")).toBeUndefined();
  });

  it("returns the hint text", () => {
    expect(parseAiBtnHint("{aiBtn:sign in}")).toBe("sign in");
    expect(parseAiBtnHint("{aiBtn:click to check in}")).toBe("click to check in");
  });

  it("trims whitespace from the hint", () => {
    expect(parseAiBtnHint("{aiBtn:  trim me  }")).toBe("trim me");
  });
});

// ---------------------------------------------------------------------------
// hasAiInput
// ---------------------------------------------------------------------------

describe("hasAiInput", () => {
  it("returns false for commands with no placeholders", () => {
    expect(hasAiInput("/start")).toBe(false);
    expect(hasAiInput("/checkin")).toBe(false);
  });

  it("returns true for the bare {aiInput} placeholder", () => {
    expect(hasAiInput("{aiInput}")).toBe(true);
    expect(hasAiInput("/start {aiInput}")).toBe(true);
  });

  it("returns true for {aiInput:N} with a length", () => {
    expect(hasAiInput("{aiInput:6}")).toBe(true);
    expect(hasAiInput("/code {aiInput:4}")).toBe(true);
  });

  it("returns false for other placeholders", () => {
    expect(hasAiInput("{word}")).toBe(false);
    expect(hasAiInput("{aiBtn}")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAiInputLength
// ---------------------------------------------------------------------------

describe("parseAiInputLength", () => {
  it("returns undefined when there is no length suffix", () => {
    expect(parseAiInputLength("{aiInput}")).toBeUndefined();
    expect(parseAiInputLength("/start {aiInput}")).toBeUndefined();
    expect(parseAiInputLength("/start")).toBeUndefined();
  });

  it("parses the length from {aiInput:N}", () => {
    expect(parseAiInputLength("{aiInput:6}")).toBe(6);
    expect(parseAiInputLength("/start {aiInput:12}")).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// buildCaptchaPrompt
// ---------------------------------------------------------------------------

describe("buildCaptchaPrompt", () => {
  it("builds a generic prompt when no length is given", () => {
    const prompt = buildCaptchaPrompt();
    expect(prompt).toBe(
      "Read this captcha image. Reply with ONLY the captcha characters(no space), nothing else.",
    );
  });

  it("includes the exact length when provided", () => {
    expect(buildCaptchaPrompt(6)).toContain("exactly 6 characters");
    expect(buildCaptchaPrompt(4)).toContain("exactly 4 characters");
  });
});

// ---------------------------------------------------------------------------
// htmlToText
// ---------------------------------------------------------------------------

describe("htmlToText", () => {
  it("leaves plain text unchanged", () => {
    expect(htmlToText("Hello World")).toBe("Hello World");
  });

  it("strips simple HTML tags", () => {
    expect(htmlToText("<strong>bold</strong>")).toBe("bold");
    expect(htmlToText("<em>italic</em>")).toBe("italic");
  });

  it("replaces block/inline tags with a space and collapses whitespace", () => {
    expect(htmlToText("<p>Hello</p><p>World</p>")).toBe("Hello World");
    expect(htmlToText("Hello<br>World")).toBe("Hello World");
  });

  it("collapses multiple whitespace runs into a single space", () => {
    expect(htmlToText("<b>a</b>   <b>b</b>")).toBe("a b");
  });

  it("trims leading and trailing whitespace", () => {
    expect(htmlToText("  <b>hi</b>  ")).toBe("hi");
  });

  it("returns an empty string for an empty input", () => {
    expect(htmlToText("")).toBe("");
  });

  it("handles nested tags", () => {
    expect(htmlToText("<div><span>text</span></div>")).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// parseAiInputHint -- the hinted placeholder, which is not {aiInput}
// ---------------------------------------------------------------------------

describe("parseAiInputHint", () => {
  it("leaves {aiInput} alone: it is a captcha reader and stays one", () => {
    expect(hasAiInputHint("{aiInput}")).toBe(false);
    expect(hasAiInputHint("{aiInput:4}")).toBe(false);
    expect(parseAiInputHint("{aiInput:4}")).toBeUndefined();
    // ...and the captcha one does not answer for the hinted placeholder either
    expect(hasAiInput("{aiInputWithCustomHint:say hello}")).toBe(false);
  });

  it("reads the hint", () => {
    expect(parseAiInputHint("{aiInputWithCustomHint:answer the question}")).toEqual({
      hint: "answer the question",
    });
    expect(parseAiInputHint("{aiInputWithCustomHint:回答上面的算术题，只回数字}")).toEqual({
      hint: "回答上面的算术题，只回数字",
    });
  });

  it("still reads the earlier `Hit` spelling, so a job saved with it keeps working", () => {
    expect(parseAiInputHint("{aiInputWithCustomHit:answer it}")).toEqual({
      hint: "answer it",
    });
    expect(hasAiInputHint("{aiInputWithCustomHit:4-6:answer it}")).toBe(true);
  });

  it("reads a leading range, either side of it optional", () => {
    expect(parseAiInputHint("{aiInputWithCustomHint:4-6:answer it}")).toEqual({
      hint: "answer it",
      minLen: 4,
      maxLen: 6,
    });
    expect(parseAiInputHint("{aiInputWithCustomHint:4-:answer it}")).toEqual({
      hint: "answer it",
      minLen: 4,
    });
    expect(parseAiInputHint("{aiInputWithCustomHint:-6:answer it}")).toEqual({
      hint: "answer it",
      maxLen: 6,
    });
  });

  it("only takes a leading segment that reads as a range, so a hint may have colons", () => {
    expect(parseAiInputHint("{aiInputWithCustomHint:reply with: yes}")).toEqual({
      hint: "reply with: yes",
    });
    expect(parseAiInputHint("{aiInputWithCustomHint:2-6:reply with: yes}")).toEqual({
      hint: "reply with: yes",
      minLen: 2,
      maxLen: 6,
    });
  });

  it("is nothing without a hint, whatever the range says", () => {
    expect(parseAiInputHint("{aiInputWithCustomHint:}")).toBeUndefined();
    expect(parseAiInputHint("{aiInputWithCustomHint:   }")).toBeUndefined();
    expect(parseAiInputHint("{aiInputWithCustomHint:4-6:}")).toBeUndefined();
  });
});

describe("buildAiInputPrompt", () => {
  it("carries the hint and the message, and says whether images came with it", () => {
    const prompt = buildAiInputPrompt({ hint: "answer the sum" }, "What is 3+5?", false);
    expect(prompt).toContain("answer the sum");
    expect(prompt).toContain("What is 3+5?");
    expect(prompt).not.toContain("image(s) attached");
    expect(prompt).not.toContain("must be");
    expect(buildAiInputPrompt({ hint: "read it" }, "see the picture", true)).toContain(
      "image(s) attached",
    );
  });

  it("tells the model the length it is being held to", () => {
    expect(buildAiInputPrompt({ hint: "x", minLen: 4, maxLen: 6 }, "", false)).toContain(
      "between 4 and 6 characters",
    );
    expect(buildAiInputPrompt({ hint: "x", minLen: 5, maxLen: 5 }, "", false)).toContain(
      "exactly 5 characters",
    );
    expect(buildAiInputPrompt({ hint: "x", minLen: 3 }, "", false)).toContain(
      "at least 3 characters",
    );
    expect(buildAiInputPrompt({ hint: "x", maxLen: 8 }, "", false)).toContain(
      "at most 8 characters",
    );
  });
});
