// The panel and the runner have to agree about the in-app steps.
//
// The config carries one string per step, because that is what the runner parses and what a
// config edited by hand still has to work as. The editor holds the same steps as forms and
// writes them back out. So the editor's converters and this side's parser are two readings of
// one format, and a disagreement between them would quietly change what a saved job does --
// which is why this test reaches across to the panel's own module rather than restating it.
//
// Rewriting is allowed, since the editor writes one canonical form per step: `delay(10s)`
// comes back as `delay(10000)`, `scroll(y=800)` as `scroll(0, 800)`. What is compared is
// therefore what the runner makes of each step, not the text of it.
import { beforeAll, describe, it, expect } from "vitest";
import {
  parseDelayStep,
  parseInAppSteps,
  parseScrollStep,
  type InAppStep,
} from "../jobs/cloudflare";

// Loaded at run time rather than imported: the panel's module lives outside this package's
// rootDir, and a static import of it would fail `tsc` (which compiles the tests too). The
// specifier is a variable so the compiler leaves it alone and vitest resolves it.
const EDITOR_MODULE = "../../../frontend/src/composables/miniAppSteps";

type StepForm = { text: string; continueAfterFail: boolean };
let miniAppStepsFromConfig: (rows: string[] | undefined) => StepForm[];
let miniAppStepsToConfig: (steps: StepForm[]) => string[];

beforeAll(async () => {
  const mod = await import(EDITOR_MODULE);
  miniAppStepsFromConfig = mod.miniAppStepsFromConfig;
  miniAppStepsToConfig = mod.miniAppStepsToConfig;
});

function meaning(steps: InAppStep[]): unknown {
  return steps.map((s) => {
    if (s.kind === "if")
      return { if: s.cond, then: meaning(s.then), else: meaning(s.otherwise) };
    const delay = parseDelayStep(s.text);
    if (delay !== null) return { delay, optional: s.optional };
    const scroll = parseScrollStep(s.text);
    if (scroll) return { scroll, optional: s.optional };
    return { text: s.text, optional: s.optional };
  });
}

/** The rows as they come back from a trip through the editor. */
const throughEditor = (rows: string[]) => miniAppStepsToConfig(miniAppStepsFromConfig(rows));

describe("in-app steps through the editor", () => {
  it.each([
    ["a bare label", ["签到"]],
    ["a short sequence", ["立即签到", "delay(10000)", "css:#ok"]],
    ["label alternatives", ["参与抽奖|加入抽奖|Join giveaway"]],
    ["a step allowed to fail", ["?css:#popup-close", "签到"]],
    ["the placeholder steps", ["{turnstile}", "{aiBtn}", "{aiBtn:签到按钮}", "{input}", "{aiInput}"]],
    [
      "every way of writing a scroll",
      ["scroll(0, 99999)", "scroll(800)", "scroll(y=800)", "scroll(x=-200)", "scroll(css:#footer)"],
    ],
    ["a delay in seconds", ["delay(10s)"]],
    ["a branch with both arms", ["if(css:#claim)", "css:#claim", "else", "text:已签到", "endif"]],
    [
      "branches nested, with an optional step inside",
      ["if(!css:#done)", "if(text:抽奖)", "?参与抽奖", "endif", "立即签到", "endif"],
    ],
    ["a branch followed by a step", ["if(css:#a)", "?css:#a", "endif", "确定"]],
  ])("means the same after a trip through the editor: %s", (_what, rows) => {
    expect(meaning(parseInAppSteps(throughEditor(rows)).steps)).toEqual(
      meaning(parseInAppSteps(rows).steps),
    );
  });

  // Rows that do not line up are the ones an editor could most easily ruin, by tidying them
  // into something that runs. They are handed back exactly as they came instead, so the run
  // still refuses them and says why.
  it.each([
    ["an if with no endif", ["if(css:#a)", "css:#a"]],
    ["an unreadable condition", ["if(#a)", "endif"]],
    ["a stray else beside a real branch", ["if(css:#a)", "css:#a", "endif", "else"]],
  ])("hands back rows that do not line up, untouched: %s", (_what, rows) => {
    expect(throughEditor(rows)).toEqual(rows);
    expect(parseInAppSteps(throughEditor(rows)).error).toBeTruthy();
  });

  // Upgrade safety. A sequence written before branches existed may hold a control labelled
  // `else`; pressing it is what that step has always done, and reading it as a block marker
  // would fail an action that has worked for months. The markers wake up only for a list
  // that opens a branch somewhere, so both sides leave these alone.
  it.each([
    ["a control labelled else", ["else"]],
    ["a control labelled endif", ["endif"]],
    ["one among ordinary steps", ["签到", "else", "delay(2000)"]],
  ])("leaves a marker word alone where nothing branches: %s", (_what, rows) => {
    expect(throughEditor(rows)).toEqual(rows);
    const plan = parseInAppSteps(rows);
    expect(plan.error).toBeUndefined();
    // Every row is a step of its own, with the marker word among them read as a label
    expect(plan.steps).toEqual(
      rows.map((r) => ({ kind: "do", text: r, optional: false })),
    );
  });

  it("drops a step whose only field was left empty, rather than writing a blank row", () => {
    const forms = miniAppStepsFromConfig(["签到"]);
    forms[0].text = "";
    expect(miniAppStepsToConfig(forms)).toEqual([]);
  });

  it("writes the optional marker from the checkbox, and reads it back into it", () => {
    const forms = miniAppStepsFromConfig(["css:#go"]);
    expect(forms[0].continueAfterFail).toBe(false);
    forms[0].continueAfterFail = true;
    expect(miniAppStepsToConfig(forms)).toEqual(["?css:#go"]);
    expect(miniAppStepsFromConfig(["?css:#go"])[0].continueAfterFail).toBe(true);
  });
});
