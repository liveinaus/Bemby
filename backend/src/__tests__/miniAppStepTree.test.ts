import { describe, it, expect } from "vitest";
import {
  describeInAppCondition,
  parseInAppCondition,
  parseInAppSteps,
  type InAppStep,
} from "../jobs/cloudflare";

/** The steps of a branch, by the text they carry, for comparing without the noise. */
function textsOf(steps: InAppStep[]): string[] {
  return steps.map((s) => (s.kind === "do" ? `${s.optional ? "?" : ""}${s.text}` : "if(...)"));
}

describe("parseInAppCondition", () => {
  it("reads an element and a text condition", () => {
    expect(parseInAppCondition("css:#claim")).toEqual({
      check: "element",
      value: "#claim",
      negate: false,
    });
    expect(parseInAppCondition("text:签到成功")).toEqual({
      check: "text",
      value: "签到成功",
      negate: false,
    });
  });

  it("takes either way of saying not, and ignores case and space", () => {
    expect(parseInAppCondition("!css:#claim")?.negate).toBe(true);
    expect(parseInAppCondition("not css:#claim")?.negate).toBe(true);
    expect(parseInAppCondition("  NOT   TEXT : 已签到 ")).toEqual({
      check: "text",
      value: "已签到",
      negate: true,
    });
  });

  // A selector may hold a colon of its own, so only the first one separates
  it("keeps the rest of the selector intact", () => {
    expect(parseInAppCondition("css:a[href^='/claim']:not(.done)")?.value).toBe(
      "a[href^='/claim']:not(.done)",
    );
  });

  it("refuses anything that names neither", () => {
    expect(parseInAppCondition("#claim")).toBeNull();
    expect(parseInAppCondition("css:")).toBeNull();
    expect(parseInAppCondition("")).toBeNull();
  });

  it("says a condition the way the log does", () => {
    expect(describeInAppCondition({ check: "element", value: "#a", negate: true })).toBe(
      "!css:#a",
    );
    expect(describeInAppCondition({ check: "text", value: "已签到", negate: false })).toBe(
      "text:已签到",
    );
  });
});

describe("parseInAppSteps", () => {
  it("leaves a list with no branches as it was", () => {
    const plan = parseInAppSteps(["立即签到", "delay(2000)", "css:#ok"]);
    expect(plan.error).toBeUndefined();
    expect(textsOf(plan.steps)).toEqual(["立即签到", "delay(2000)", "css:#ok"]);
  });

  it("drops blank rows, the way the panel leaves them behind", () => {
    expect(textsOf(parseInAppSteps(["立即签到", "  ", ""]).steps)).toEqual(["立即签到"]);
  });

  it("marks a step written with a leading ? as one the run can do without", () => {
    const plan = parseInAppSteps(["?css:#popup-close", "立即签到"]);
    expect(plan.steps[0]).toEqual({ kind: "do", text: "css:#popup-close", optional: true });
    expect(plan.steps[1]).toEqual({ kind: "do", text: "立即签到", optional: false });
  });

  it("builds a branch from if/else/endif", () => {
    const plan = parseInAppSteps([
      "if(css:#claim)",
      "css:#claim",
      "delay(1000)",
      "else",
      "text:已签到",
      "endif",
      "确定",
    ]);
    expect(plan.error).toBeUndefined();
    expect(plan.steps).toHaveLength(2);
    const branch = plan.steps[0];
    if (branch.kind !== "if") throw new Error("expected a branch");
    expect(branch.cond).toEqual({ check: "element", value: "#claim", negate: false });
    expect(textsOf(branch.then)).toEqual(["css:#claim", "delay(1000)"]);
    expect(textsOf(branch.otherwise)).toEqual(["text:已签到"]);
    expect(textsOf([plan.steps[1]])).toEqual(["确定"]);
  });

  it("takes a branch with no else, and one nested inside another", () => {
    const plan = parseInAppSteps([
      "if(!css:#done)",
      "if(text:抽奖)",
      "?参与抽奖",
      "endif",
      "立即签到",
      "endif",
    ]);
    expect(plan.error).toBeUndefined();
    const outer = plan.steps[0];
    if (outer.kind !== "if") throw new Error("expected a branch");
    expect(outer.cond.negate).toBe(true);
    expect(outer.otherwise).toEqual([]);
    expect(textsOf(outer.then)).toEqual(["if(...)", "立即签到"]);
    const inner = outer.then[0];
    if (inner.kind !== "if") throw new Error("expected a nested branch");
    expect(textsOf(inner.then)).toEqual(["?参与抽奖"]);
  });

  it("accepts endif written as two words, and any casing", () => {
    expect(parseInAppSteps(["IF(css:#a)", "css:#a", "END IF"]).error).toBeUndefined();
  });

  // A sequence whose blocks do not line up means something the list does not say, and
  // guessing at it would report a checkin that never happened
  it("refuses blocks that do not line up, naming what is wrong", () => {
    expect(parseInAppSteps(["if(css:#a)", "css:#a"]).error).toMatch(/no `endif`/);
    expect(parseInAppSteps(["if(css:#a)", "endif", "else"]).error).toMatch(
      /`else` has no `if/,
    );
    expect(parseInAppSteps(["if(css:#a)", "endif", "endif"]).error).toMatch(
      /`endif` has no `if/,
    );
    expect(
      parseInAppSteps(["if(css:#a)", "else", "else", "endif"]).error,
    ).toMatch(/two `else`/);
    expect(parseInAppSteps(["if(#a)", "endif"]).error).toMatch(/not a condition/);
    expect(parseInAppSteps(["?"]).error).toMatch(/on its own/);
  });

  // A sequence written before branches existed may hold a control labelled `else`. Pressing
  // it is what that step has always done, so the markers mean nothing until a list opens a
  // branch -- otherwise an upgrade would fail an action that has worked for months.
  it("reads a marker word as a label where the list opens no branch", () => {
    expect(parseInAppSteps(["else"]).steps).toEqual([
      { kind: "do", text: "else", optional: false },
    ]);
    expect(parseInAppSteps(["签到", "endif"]).error).toBeUndefined();
    expect(textsOf(parseInAppSteps(["签到", "endif"]).steps)).toEqual(["签到", "endif"]);
  });

  it("runs nothing when the blocks are wrong", () => {
    expect(parseInAppSteps(["if(css:#a)", "css:#a"]).steps).toEqual([]);
  });
});
