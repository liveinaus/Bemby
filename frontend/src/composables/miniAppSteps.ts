/**
 * The Mini App in-app steps, as the editor holds them and as the API takes them.
 *
 * The API takes one string per step -- `立即签到`, `css:#go`, `delay(2000)`, `if(css:#x)` --
 * because that is what the runner parses, and a config edited by hand still has to work. The
 * editor holds the same steps as forms instead: a type, its own fields, and a branch's arms as
 * lists of their own, so a step is filled in rather than typed out. The two converters below
 * are the only place the string forms are written or read.
 */

/** The kinds of step the app editor offers, in the order the picker lists them. */
export const MINI_APP_STEP_TYPES = [
  "label",
  "css",
  "delay",
  "scroll",
  "turnstile",
  "aiBtn",
  "input",
  "aiInput",
  "if",
] as const;

export type MiniAppStepType = (typeof MINI_APP_STEP_TYPES)[number];

/** Types that need the vision model, so the editor can gate them on a configured key. */
export const AI_MINI_APP_STEP_TYPES: MiniAppStepType[] = ["aiBtn", "aiInput"];

/** How deep branches may nest, matching the web step editor. */
export const MAX_MINI_APP_STEP_DEPTH = 3;

export type MiniAppStepForm = {
  type: MiniAppStepType;
  /** label: the control's own text (`|` separated alternatives). if+text: the words. */
  text: string;
  /** css: the selector. if+element: the selector. */
  selector: string;
  /** aiBtn: what to tell the model to look for. */
  hint: string;
  /** delay: how long to wait. */
  waitMs: number;
  /** scroll: by a distance, or until an element is in view. */
  scrollMode: "pixels" | "selector";
  scrollX: number;
  scrollY: number;
  scrollSelector: string;
  /** if: whether it asks about an element or about the page's words. */
  check: "element" | "text";
  /** if: run the arms the other way round. */
  negate: boolean;
  /** Carry on with the next step when this one fails. */
  continueAfterFail: boolean;
  /** if: the steps run when it holds, and when it does not. */
  steps: MiniAppStepForm[];
  elseSteps: MiniAppStepForm[];
  /** Folded shut in the editor. Read by nothing else, and never written to a config. */
  collapsed?: boolean;
  /**
   * A row this build cannot read as any step it knows -- written by a newer Bemby, or by hand.
   * Kept exactly as it came so saving writes it back untouched; picking a real type discards it.
   */
  raw?: string;
};

export function blankMiniAppStep(type: MiniAppStepType = "label"): MiniAppStepForm {
  return {
    type,
    text: "",
    selector: "",
    hint: "",
    waitMs: type === "delay" ? 5000 : 0,
    scrollMode: "pixels",
    scrollX: 0,
    scrollY: 800,
    scrollSelector: "",
    check: "element",
    negate: false,
    continueAfterFail: false,
    steps: [],
    elseSteps: [],
  };
}

/** What the editor may offer at this depth: a branch cannot go past the nesting limit. */
export function offeredMiniAppStepTypes(depth: number, current: MiniAppStepType) {
  return MINI_APP_STEP_TYPES.filter(
    (ty) => ty === current || ty !== "if" || depth + 1 < MAX_MINI_APP_STEP_DEPTH,
  );
}

const DELAY_ROW = /^delay\(\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*\)$/i;
const SCROLL_ROW = /^scroll\(([^)]*)\)$/i;
const AI_BTN_ROW = /^\{\s*aibtn\s*(?::([\s\S]*))?\}$/i;
const TURNSTILE_ROW = /^\{\s*turnstile\s*\??\s*\}$/i;
const IF_ROW = /^if\s*\(([\s\S]*)\)$/i;
const ELSE_ROW = /^else$/i;
const ENDIF_ROW = /^end\s*if$/i;

/** The inside of an `if(...)`, as the runner reads it. */
function conditionOf(raw: string): Pick<MiniAppStepForm, "check" | "selector" | "text" | "negate"> | null {
  let inner = raw.trim();
  let negate = false;
  const not = /^(?:!\s*|not\s+)([\s\S]*)$/i.exec(inner);
  if (not) {
    negate = true;
    inner = not[1].trim();
  }
  const m = /^(css|text)\s*:\s*([\s\S]+)$/i.exec(inner);
  if (!m) return null;
  const value = m[2].trim();
  if (!value) return null;
  return m[1].toLowerCase() === "css"
    ? { check: "element", selector: value, text: "", negate }
    : { check: "text", selector: "", text: value, negate };
}

/** One row as a form, or null for a row that is none of the known steps. */
function rowToStep(row: string): MiniAppStepForm | null {
  const delay = DELAY_ROW.exec(row);
  if (delay) {
    const n = Number(delay[1]);
    const step = blankMiniAppStep("delay");
    step.waitMs = Math.round(delay[2]?.toLowerCase() === "s" ? n * 1000 : n);
    return step;
  }

  const scroll = SCROLL_ROW.exec(row);
  if (scroll) {
    const step = blankMiniAppStep("scroll");
    const inner = scroll[1].trim();
    const named = /^css\s*:\s*(.+)$/is.exec(inner);
    if (named) {
      step.scrollMode = "selector";
      step.scrollSelector = named[1].trim();
      return step;
    }
    // `scroll(0, 800)`, `scroll(800)`, `scroll(y=800)`, `scroll(x:-200)`
    step.scrollMode = "pixels";
    step.scrollX = 0;
    step.scrollY = 0;
    const parts = inner.split(",").map((p) => p.trim()).filter(Boolean);
    const bare: number[] = [];
    for (const part of parts) {
      const axis = /^([xy])\s*[=:]\s*(-?\d+(?:\.\d+)?)$/i.exec(part);
      if (axis) {
        const value = Math.round(Number(axis[2]));
        if (axis[1].toLowerCase() === "x") step.scrollX = value;
        else step.scrollY = value;
        continue;
      }
      const n = Number(part);
      if (!Number.isFinite(n)) return null;
      bare.push(Math.round(n));
    }
    if (bare.length === 1) step.scrollY = bare[0];
    else if (bare.length === 2) {
      step.scrollX = bare[0];
      step.scrollY = bare[1];
    } else if (bare.length > 2) return null;
    return step;
  }

  if (TURNSTILE_ROW.test(row)) return blankMiniAppStep("turnstile");

  const ai = AI_BTN_ROW.exec(row);
  if (ai) {
    const step = blankMiniAppStep("aiBtn");
    step.hint = ai[1]?.trim() ?? "";
    return step;
  }

  if (/^\{\s*input\s*\}$/i.test(row)) return blankMiniAppStep("input");
  if (/^\{\s*aiinput\s*\}$/i.test(row)) return blankMiniAppStep("aiInput");

  const css = /^css\s*:\s*([\s\S]+)$/i.exec(row);
  if (css) {
    const step = blankMiniAppStep("css");
    step.selector = css[1].trim();
    return step;
  }

  // Anything else is the label of a control to press, which is what most steps are
  if (/^\{|^end\s*if$|^else$/i.test(row)) return null;
  const step = blankMiniAppStep("label");
  step.text = row;
  return step;
}

/**
 * The rows as the tree they describe. Rows that do not line up -- an `if` never closed, a
 * stray `else` -- are kept as they came rather than rearranged: the editor shows them as rows
 * it cannot read, which is honest about a config it would otherwise change the meaning of.
 */
export function miniAppStepsFromConfig(rows: string[] | undefined): MiniAppStepForm[] {
  const source = (rows ?? []).map((r) => (r ?? "").trim()).filter(Boolean);
  const unreadable = (): MiniAppStepForm[] =>
    source.map((row) => {
      const step = blankMiniAppStep("label");
      step.raw = row;
      step.text = row;
      return step;
    });

  type Frame = { step: MiniAppStepForm; inElse: boolean };
  const top: MiniAppStepForm[] = [];
  const open: Frame[] = [];
  const holding = (): MiniAppStepForm[] => {
    const frame = open[open.length - 1];
    if (!frame) return top;
    return frame.inElse ? frame.step.elseSteps : frame.step.steps;
  };

  for (const row of source) {
    const opened = IF_ROW.exec(row);
    if (opened) {
      const cond = conditionOf(opened[1]);
      if (!cond) return unreadable();
      const step = blankMiniAppStep("if");
      Object.assign(step, cond);
      open.push({ step, inElse: false });
      continue;
    }
    if (ELSE_ROW.test(row)) {
      const frame = open[open.length - 1];
      if (!frame || frame.inElse) return unreadable();
      frame.inElse = true;
      continue;
    }
    if (ENDIF_ROW.test(row)) {
      const frame = open.pop();
      if (!frame) return unreadable();
      holding().push(frame.step);
      continue;
    }

    const optional = row.startsWith("?");
    const body = optional ? row.slice(1).trim() : row;
    if (!body) return unreadable();
    const step = rowToStep(body);
    if (!step) {
      const kept = blankMiniAppStep("label");
      kept.raw = row;
      kept.text = row;
      holding().push(kept);
      continue;
    }
    step.continueAfterFail = optional;
    holding().push(step);
  }

  return open.length ? unreadable() : top;
}

/** One step as the row the runner reads, without the optional marker. */
function stepToRow(step: MiniAppStepForm): string {
  if (step.raw) return step.raw;
  switch (step.type) {
    case "css":
      return step.selector.trim() ? `css:${step.selector.trim()}` : "";
    case "delay":
      return `delay(${Math.max(0, Math.round(step.waitMs || 0))})`;
    case "scroll":
      return step.scrollMode === "selector"
        ? step.scrollSelector.trim()
          ? `scroll(css:${step.scrollSelector.trim()})`
          : ""
        : `scroll(${Math.round(step.scrollX || 0)}, ${Math.round(step.scrollY || 0)})`;
    case "turnstile":
      return "{turnstile}";
    case "aiBtn":
      return step.hint.trim() ? `{aiBtn:${step.hint.trim()}}` : "{aiBtn}";
    case "input":
      return "{input}";
    case "aiInput":
      return "{aiInput}";
    default:
      return step.text.trim();
  }
}

/** An `if` step's own row, e.g. `if(!css:#claim)`. */
function conditionRow(step: MiniAppStepForm): string {
  const value = step.check === "element" ? step.selector.trim() : step.text.trim();
  return `if(${step.negate ? "!" : ""}${step.check === "element" ? "css" : "text"}:${value})`;
}

/** The forms flattened back to rows, branches included. Blank steps are left out. */
export function miniAppStepsToConfig(steps: MiniAppStepForm[]): string[] {
  const rows: string[] = [];
  for (const step of steps) {
    if (step.type === "if") {
      const value = step.check === "element" ? step.selector.trim() : step.text.trim();
      // A branch with nothing to ask about, or nothing to run, would only be noise in a config
      if (!value || (!step.steps.length && !step.elseSteps.length)) continue;
      rows.push(conditionRow(step));
      rows.push(...miniAppStepsToConfig(step.steps));
      if (step.elseSteps.length) {
        rows.push("else");
        rows.push(...miniAppStepsToConfig(step.elseSteps));
      }
      rows.push("endif");
      continue;
    }
    const row = stepToRow(step);
    if (!row) continue;
    rows.push(step.continueAfterFail && !step.raw ? `?${row}` : row);
  }
  return rows;
}

/**
 * The steps as the API takes them. An empty list is left off altogether, which is what asks
 * the run to auto-detect a checkin-worded control.
 */
export function appButtonsOf(steps: MiniAppStepForm[]): { appButtons?: string[] } {
  const rows = miniAppStepsToConfig(steps);
  return rows.length ? { appButtons: rows } : {};
}
