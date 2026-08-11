// The `ai_web_*` sub-steps ask the vision model for a marker number and get back whatever
// the model felt like sending: the JSON that was asked for, the same JSON in a fence, a
// sentence with the number in it. Anything a number can be read out of is a usable answer,
// so the parser has to be forgiving -- but not so forgiving that it invents a marker and
// clicks something nobody asked for.
vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, it, expect, vi } from "vitest";
import { parseWebAiPoint, parseWebAiPoints, parseWebAiReply } from "../jobs/cloudflare";

describe("parseWebAiReply", () => {
  it("reads the JSON object it asked for", () => {
    expect(parseWebAiReply('{"mark": 3}')).toEqual({ mark: 3, text: undefined });
  });

  it("reads a mark and the text to type", () => {
    expect(parseWebAiReply('{"mark": 2, "text": "A7X9"}')).toEqual({ mark: 2, text: "A7X9" });
  });

  it("finds the object inside a code fence", () => {
    expect(parseWebAiReply('```json\n{"mark": 5}\n```')).toEqual({ mark: 5, text: undefined });
  });

  it("finds the object inside surrounding prose", () => {
    const reply = 'Looking at the page, the login button is marker 4.\n{"mark": 4}\nHope that helps!';
    expect(parseWebAiReply(reply).mark).toBe(4);
  });

  it("falls back to a key/value pair when the JSON will not parse", () => {
    expect(parseWebAiReply('{mark: 7, note: unquoted}').mark).toBe(7);
  });

  it("accepts a bare number, which is what small models tend to send", () => {
    expect(parseWebAiReply("6").mark).toBe(6);
    expect(parseWebAiReply("Marker 11").mark).toBe(11);
  });

  it("reports no mark when the model declines, so the step fails instead of guessing", () => {
    expect(parseWebAiReply('{"mark": 0}').mark).toBeUndefined();
    expect(parseWebAiReply("none of them are right").mark).toBeUndefined();
    expect(parseWebAiReply("").mark).toBeUndefined();
  });

  it("ignores a non-integer mark rather than rounding it into a different element", () => {
    expect(parseWebAiReply('{"mark": 2.5}').mark).toBeUndefined();
    expect(parseWebAiReply('{"mark": "the blue one"}').mark).toBeUndefined();
  });

  it("keeps the text only when it is a string", () => {
    expect(parseWebAiReply('{"mark": 1, "text": 42}').text).toBeUndefined();
    expect(parseWebAiReply('{"mark": 1, "text": ""}').text).toBe("");
  });
});

// `ai_web_click_xy` asks for a position instead of a marker, and gets back the same spread
// of replies. Nothing checks the answer against a real element here -- the click lands
// wherever the model said -- so a reply that carries no position must read as none at all.
describe("parseWebAiPoint", () => {
  it("reads the JSON object it asked for", () => {
    expect(parseWebAiPoint('{"x": 412, "y": 300}')).toEqual({ x: 412, y: 300 });
  });

  it("finds the object inside a fence or prose", () => {
    expect(parseWebAiPoint('```json\n{"x": 20, "y": 40}\n```')).toEqual({ x: 20, y: 40 });
    expect(parseWebAiPoint('The checkbox sits here: {"x": 205, "y": 274}.')).toEqual({
      x: 205,
      y: 274,
    });
  });

  it("takes a decimal position, since the mouse is aimed in whole pixels anyway", () => {
    expect(parseWebAiPoint('{"x": 205.5, "y": 274.25}')).toEqual({ x: 205.5, y: 274.25 });
  });

  it("falls back to a key/value pair when the JSON will not parse", () => {
    expect(parseWebAiPoint("{x: 100, y: 250, note: unquoted}")).toEqual({ x: 100, y: 250 });
    expect(parseWebAiPoint("x=64 y=128")).toEqual({ x: 64, y: 128 });
  });

  it("accepts a bare pair, which is what small models tend to send", () => {
    expect(parseWebAiPoint("412, 300")).toEqual({ x: 412, y: 300 });
    expect(parseWebAiPoint("The centre is at 412 300")).toEqual({ x: 412, y: 300 });
  });

  it("reports no position when the model declines, so the step fails instead of guessing", () => {
    expect(parseWebAiPoint("I cannot see the checkbox")).toBeUndefined();
    expect(parseWebAiPoint("")).toBeUndefined();
    expect(parseWebAiPoint('{"x": 100}')).toBeUndefined();
  });

  // The close-up pass is told to answer this way when the target is outside its window.
  // `Number(null)` is 0, so a loose read would turn "not in view" into the page's corner.
  it("treats a null or blank position as none, not as 0,0", () => {
    expect(parseWebAiPoint('{"x": null, "y": null, "what": "not in view"}')).toBeUndefined();
    expect(parseWebAiPoint('{"x": "", "y": ""}')).toBeUndefined();
    expect(parseWebAiPoint('{"x": false, "y": false}')).toBeUndefined();
  });

  it("keeps what the model says it is pointing at, for the log", () => {
    expect(parseWebAiPoint('{"x": 344, "y": 456, "what": "the checkbox"}')).toEqual({
      x: 344,
      y: 456,
      what: "the checkbox",
    });
    expect(parseWebAiPoint('{"x": 344, "y": 456, "what": 42}')?.what).toBeUndefined();
  });
});

// `ai_web_click_xy_multi` asks for the lot in one reply. Order is part of the answer -- a
// captcha wanting its characters in a stated order is failed by the right places in the
// wrong sequence -- so nothing here sorts or dedupes what came back.
describe("parseWebAiPoints", () => {
  it("reads the list it asked for, in the order given", () => {
    expect(parseWebAiPoints('{"points": [{"x": 10, "y": 20}, {"x": 300, "y": 40}]}')).toEqual([
      { x: 10, y: 20 },
      { x: 300, y: 40 },
    ]);
  });

  it("keeps what the model says each position is, for the log and the close-up pass", () => {
    expect(
      parseWebAiPoints('{"points": [{"x": 10, "y": 20, "what": "the first tile"}]}'),
    ).toEqual([{ x: 10, y: 20, what: "the first tile" }]);
  });

  it("finds the list inside a fence or prose", () => {
    expect(parseWebAiPoints('```json\n{"points": [{"x": 1, "y": 2}]}\n```')).toEqual([
      { x: 1, y: 2 },
    ]);
  });

  it("falls back to each object on its own when the list will not parse", () => {
    expect(parseWebAiPoints("Here they are: {x: 10, y: 20} then {x: 30, y: 40}")).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
  });

  it("reads a line at a time when no JSON came back at all", () => {
    expect(parseWebAiPoints("1. 412, 300\n2. 500, 620")).toEqual([
      { x: 412, y: 300 },
      { x: 500, y: 620 },
    ]);
  });

  it("takes a single position as a list of one", () => {
    expect(parseWebAiPoints('{"x": 412, "y": 300}')).toEqual([{ x: 412, y: 300 }]);
  });

  it("gives back nothing when the model found nothing, so the step fails instead of guessing", () => {
    expect(parseWebAiPoints('{"points": []}')).toEqual([]);
    expect(parseWebAiPoints("I cannot see any of them")).toEqual([]);
    expect(parseWebAiPoints("")).toEqual([]);
  });

  it("drops the entries carrying no position rather than clicking the page corner", () => {
    expect(
      parseWebAiPoints('{"points": [{"x": 10, "y": 20}, {"x": null, "y": null}]}'),
    ).toEqual([{ x: 10, y: 20 }]);
  });

  it("takes the list, not the working out a model volunteered beside it", () => {
    const reply = JSON.stringify({
      considered: [
        { x: 200, y: 400, what: "a dolphin", match: false },
        { x: 324, y: 574, what: "a koala", match: true },
      ],
      points: [{ x: 324, y: 574, what: "a koala" }],
    });
    expect(parseWebAiPoints(reply)).toEqual([{ x: 324, y: 574, what: "a koala" }]);
  });

  it("clicks nothing when an empty list came with the candidates it turned down", () => {
    // Those candidates are positions too, and a fall-through to the looser reads below would
    // take the rejected ones for the answer and click every one of them
    const reply = JSON.stringify({
      considered: [
        { x: 200, y: 400, what: "a dolphin", match: false },
        { x: 260, y: 400, what: "a shark", match: false },
      ],
      points: [],
    });
    expect(parseWebAiPoints(reply)).toEqual([]);
  });
});
