// What an {aiBtn} verification is allowed to press. These prompts carry the admins'
// verdict buttons beside the joiner's own answer buttons, and either of those pressed by
// mistake fails the verification -- so they never reach the model in the first place.
vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, it, expect, vi } from "vitest";
import { verifyAiButtonRows } from "../jobs/custom";
import type { Api } from "telegram";

const rows = (...layout: string[][]) =>
  layout.map((texts) => ({
    buttons: texts.map((text) => ({ text })),
  })) as unknown as Api.TypeKeyboardButtonRow[];

describe("verifyAiButtonRows", () => {
  it("offers the answer buttons and withholds the admin controls beside them", () => {
    expect(
      verifyAiButtonRows(
        rows(["2", "8", "0", "73", "55", "74"], ["通过", "拒绝", "拒绝并举报骚扰"]),
      ),
    ).toEqual([["2", "8", "0", "73", "55", "74"]]);
  });

  it("keeps a member's own verify button, which only reads like the admin's", () => {
    expect(verifyAiButtonRows(rows(["通过验证", "拒绝"]))).toEqual([["通过验证"]]);
  });

  it("keeps a lone 通过 when no decline marks it as the admins'", () => {
    expect(verifyAiButtonRows(rows(["通过", "我不是机器人"]))).toEqual([
      ["通过", "我不是机器人"],
    ]);
  });

  it("drops blank labels and the rows left empty by the filtering", () => {
    expect(verifyAiButtonRows(rows(["  8  ", ""], ["拒绝"], ["Cancel", "Verify"]))).toEqual([
      ["8"],
      ["Verify"],
    ]);
  });

  it("returns nothing when the prompt offers only admin controls", () => {
    expect(verifyAiButtonRows(rows(["通过", "拒绝"]))).toEqual([]);
  });
});
