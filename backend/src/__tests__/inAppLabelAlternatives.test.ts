// The same control is worded differently depending on the language a Mini App renders in,
// so one step names every wording it might carry: `Join giveaway|参与抽奖|加入抽奖`.

import { describe, it, expect } from "vitest";
import {
  parseLabelAlternatives,
  textSaysFail,
  textSaysSuccess,
} from "../jobs/placeholders";
import { inAppLabelRegex } from "../jobs/cloudflare";

/** How clickInAppControl turns the alternatives into the matcher it searches with. */
function matcher(step: string): RegExp {
  return inAppLabelRegex(parseLabelAlternatives(step));
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

// The outcome matchers read a `|` list the same way, which is what a bot with more than one
// wording for the same result needs: "签到成功|签到中" takes whichever of them turns up.
describe("textSaysSuccess", () => {
  it("takes any one of the wordings", () => {
    expect(textSaysSuccess("🎉 签到成功！获得 145 积分", "签到成功|签到中")).toBe(true);
    expect(textSaysSuccess("签到中...", "签到成功|签到中")).toBe(true);
  });

  it("says no when none of them is there", () => {
    expect(textSaysSuccess("请稍后再试", "签到成功|签到中")).toBe(false);
  });

  it("still matches a plain single wording", () => {
    expect(textSaysSuccess("签到成功", "签到成功")).toBe(true);
    expect(textSaysSuccess("签到失败", "签到成功")).toBe(false);
  });

  it("has nothing to prove when no matcher is set", () => {
    expect(textSaysSuccess("anything", undefined)).toBe(true);
    expect(textSaysSuccess("anything", "   ")).toBe(true);
  });
});

describe("textSaysFail", () => {
  it("takes any one of the wordings", () => {
    expect(textSaysFail("您今天已经签到过了", "已经签到|重复签到")).toBe(true);
    expect(textSaysFail("重复签到", "已经签到|重复签到")).toBe(true);
  });

  it("says nothing failed without a matcher, or when none of them is there", () => {
    expect(textSaysFail("签到成功", "已经签到|重复签到")).toBe(false);
    expect(textSaysFail("anything", undefined)).toBe(false);
    expect(textSaysFail("anything", "  ")).toBe(false);
  });
});
