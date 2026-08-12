// The same control is worded differently depending on the language a Mini App renders in,
// so one step names every wording it might carry: `Join giveaway|参与抽奖|加入抽奖`.

import { describe, it, expect } from "vitest";
import { parseLabelAlternatives } from "../jobs/placeholders";

/** How clickInAppControl turns the alternatives into the matcher it searches with. */
function matcher(step: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(parseLabelAlternatives(step).map(escape).join("|"), "i");
}

describe("parseLabelAlternatives", () => {
  it("keeps a single label as one alternative", () => {
    expect(parseLabelAlternatives("Join giveaway")).toEqual(["Join giveaway"]);
  });

  it("splits the wordings a control may carry", () => {
    expect(parseLabelAlternatives("Join giveaway|参与抽奖|加入抽奖")).toEqual([
      "Join giveaway",
      "参与抽奖",
      "加入抽奖",
    ]);
  });

  it("trims the spacing an operator naturally types", () => {
    expect(parseLabelAlternatives(" Join giveaway | 参与抽奖 ")).toEqual([
      "Join giveaway",
      "参与抽奖",
    ]);
  });

  it("drops empty entries from a stray separator", () => {
    expect(parseLabelAlternatives("Join||参与抽奖|")).toEqual(["Join", "参与抽奖"]);
  });
});

describe("the matcher built from them", () => {
  const re = () => matcher("Join giveaway|参与抽奖|加入抽奖");

  it("matches whichever wording the app rendered", () => {
    expect(re().test("Join giveaway")).toBe(true);
    expect(re().test("参与抽奖")).toBe(true);
    expect(re().test("加入抽奖")).toBe(true);
  });

  it("matches the label inside a longer caption, and ignores case", () => {
    expect(re().test("立即参与抽奖 →")).toBe(true);
    expect(re().test("JOIN GIVEAWAY")).toBe(true);
  });

  it("does not match a control the step never named", () => {
    expect(re().test("Cancel")).toBe(false);
    expect(re().test("退出")).toBe(false);
  });

  it("treats regex characters in a label as literal text", () => {
    const special = matcher("Claim (1+1)|领取 [限时]");
    expect(special.test("Claim (1+1)")).toBe(true);
    expect(special.test("领取 [限时]")).toBe(true);
    // The parentheses are the label's own, not a group around anything
    expect(special.test("Claim 11")).toBe(false);
  });
});
