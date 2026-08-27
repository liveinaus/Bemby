// Two ways a Mini App checkin that worked used to be logged as a failure: the step pressed
// the app's own success wording (a result, not a control) and the app therefore did not
// react, and the success wording sat in a toast that was gone again by the time the final
// page was read.

import { describe, it, expect } from "vitest";
import { inAppLabelRegex, weakClickWasSpent } from "../jobs/cloudflare";
import { runSaysSuccess } from "../jobs/placeholders";

describe("weakClickWasSpent", () => {
  it("rescues a step that pressed the outcome an earlier step brought up", () => {
    expect(
      weakClickWasSpent({
        priorText: "每日签到\n签到可获得积分",
        text: "每日签到\n签到成功！获得 5 积分",
        successContains: "签到成功",
      }),
    ).toBe(true);
  });

  it("reads the app's own wording when the job configured none", () => {
    expect(
      weakClickWasSpent({ priorText: "每日签到", text: "每日签到\n打卡成功" }),
    ).toBe(true);
    expect(weakClickWasSpent({ priorText: "Daily check-in", text: "Checked-in" })).toBe(true);
  });

  it("takes any one of the configured wordings", () => {
    expect(
      weakClickWasSpent({
        priorText: "每日签到",
        text: "今日已签到",
        successContains: "签到成功|已签到",
      }),
    ).toBe(true);
  });

  it("does not rescue a page that never moved", () => {
    expect(
      weakClickWasSpent({
        priorText: "每日签到",
        text: "每日签到",
        successContains: "签到成功",
      }),
    ).toBe(false);
  });

  it("ignores wording that was page furniture all along", () => {
    // "签到成功后可获得积分" is a description of the reward, not a checkin that happened
    const furniture = "每日签到\n签到成功后可获得 5 积分";
    expect(
      weakClickWasSpent({ priorText: furniture, text: furniture, successContains: "签到成功" }),
    ).toBe(false);
  });

  it("holds nothing against a run with no standing text to compare", () => {
    expect(weakClickWasSpent({ text: "签到成功", successContains: "签到成功" })).toBe(true);
  });
});

describe("runSaysSuccess", () => {
  const seen = "每日签到\n签到成功！获得 5 积分";
  const final = "每日签到\n本月已签到 3 天";

  it("takes the wording from the final page when it is still there", () => {
    expect(runSaysSuccess(seen, undefined, "签到成功")).toEqual({ ok: true, transient: false });
  });

  it("takes it from a toast the app has since cleared", () => {
    expect(runSaysSuccess(final, seen, "签到成功")).toEqual({ ok: true, transient: true });
  });

  it("fails a run that never showed it at all", () => {
    expect(runSaysSuccess(final, "每日签到\n请稍后再试", "签到成功")).toEqual({
      ok: false,
      transient: false,
    });
  });

  it("has nothing to prove when no wording is configured", () => {
    expect(runSaysSuccess(final, undefined, undefined)).toEqual({ ok: true, transient: false });
    expect(runSaysSuccess("", undefined, "  ")).toEqual({ ok: true, transient: false });
  });
});

describe("inAppLabelRegex", () => {
  it("matches a label inside a longer caption by default", () => {
    expect(inAppLabelRegex(["签到"]).test("立即签到 >")).toBe(true);
    expect(inAppLabelRegex(["签到"]).test("签到成功")).toBe(true);
  });

  it("holds out for the control itself when exact matching is asked for", () => {
    const exact = () => inAppLabelRegex(["签到"], true);
    expect(exact().test("签到")).toBe(true);
    expect(exact().test("签到成功")).toBe(false);
    expect(exact().test("立即签到 >")).toBe(false);
  });

  it("anchors every alternative, not only the last", () => {
    const exact = () => inAppLabelRegex(["签到", "Check in"], true);
    expect(exact().test("签到")).toBe(true);
    expect(exact().test("check in")).toBe(true);
    expect(exact().test("Check in now")).toBe(false);
    expect(exact().test("每日签到")).toBe(false);
  });

  it("keeps regex characters in a label literal", () => {
    expect(inAppLabelRegex(["领取 [限时]"], true).test("领取 [限时]")).toBe(true);
    expect(inAppLabelRegex(["Claim (1+1)"]).test("Claim 11")).toBe(false);
  });

  it("falls back to auto-detection with no label given", () => {
    const auto = inAppLabelRegex([], true);
    expect(auto.test("每日签到")).toBe(true);
    expect(auto.test("Check-in")).toBe(true);
    expect(auto.test("Settings")).toBe(false);
  });
});
