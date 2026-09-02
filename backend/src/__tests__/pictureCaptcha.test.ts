// The pure half of the picture-captcha solver: what the model is asked, and what is made of
// its answer. The browser half is exercised against the live widget; this is the part that
// has to hold when the model replies in a shape nobody planned for.
import { describe, expect, it } from "vitest";
import {
  buildCaptchaTilesPrompt,
  parseCaptchaTiles,
  tileGridBox,
} from "../jobs/pictureCaptcha";

const tile = (n: number, x: number, y: number) => ({ n, x, y, width: 120, height: 120 });

describe("buildCaptchaTilesPrompt", () => {
  it("puts the widget's own question in it, quoted", () => {
    const prompt = buildCaptchaTilesPrompt("Select all bicycles", 9, false);
    expect(prompt).toContain('"Select all bicycles"');
    expect(prompt).toContain("grid of 9 tiles");
  });

  it("says which picture is the example when one is given", () => {
    const withExample = buildCaptchaTilesPrompt("Things more expensive than shown", 9, true);
    expect(withExample).toMatch(/first picture given is the example/i);
    const without = buildCaptchaTilesPrompt("Things more expensive than shown", 9, false);
    expect(without).not.toMatch(/first picture given is the example/i);
  });

  it("asks for a verdict on every tile, which is what stops it naming only the obvious one", () => {
    const prompt = buildCaptchaTilesPrompt("Select all cats", 9, false);
    expect(prompt).toContain('"match": true|false');
    expect(prompt).toMatch(/all 9/);
    expect(prompt).toMatch(/Include every tile/i);
  });

  it("carries the step's own hint through when there is one", () => {
    expect(buildCaptchaTilesPrompt("Select the sun", 9, false, "the star, not a son")).toContain(
      "the star, not a son",
    );
  });
});

describe("parseCaptchaTiles", () => {
  it("takes the list the model was asked for", () => {
    expect(parseCaptchaTiles('{"seen": [], "tiles": [1, 4, 9]}', 9)).toEqual([1, 4, 9]);
  });

  it("reads the verdicts when the reply was cut off before the list", () => {
    const truncated =
      '{"seen": [{"n": 1, "is": "a tower", "match": false},' +
      '{"n": 4, "is": "orange juice", "match": true},' +
      '{"n": 8, "is": "strawberries", "match": true},' +
      '{"n": 9, "is": "a glass of milk", "match": tr';
    expect(parseCaptchaTiles(truncated, 9)).toEqual([4, 8]);
  });

  it("finds the list inside prose the model added anyway", () => {
    expect(parseCaptchaTiles('Here you go: {"tiles": [2, 5]} -- hope that helps', 9)).toEqual([
      2, 5,
    ]);
  });

  it("answers nothing for an empty list rather than falling through to the verdicts", () => {
    const reply = '{"seen": [{"n": 1, "is": "a bus", "match": true}], "tiles": []}';
    expect(parseCaptchaTiles(reply, 9)).toEqual([]);
  });

  it("drops numbers that are not tiles", () => {
    expect(parseCaptchaTiles('{"tiles": [0, 3, 12, -2, 9]}', 9)).toEqual([3, 9]);
  });

  it("keeps each tile once", () => {
    expect(parseCaptchaTiles('{"tiles": [3, 3, 7, 7, 7]}', 9)).toEqual([3, 7]);
  });

  it("answers nothing for a reply with nothing in it", () => {
    expect(parseCaptchaTiles("", 9)).toEqual([]);
    expect(parseCaptchaTiles("I cannot help with that.", 9)).toEqual([]);
  });

  it("holds to the tile count it was given", () => {
    // A four-tile challenge: a reply naming nine is a reply about another grid
    expect(parseCaptchaTiles('{"tiles": [1, 2, 5, 9]}', 4)).toEqual([1, 2]);
  });
});

describe("tileGridBox", () => {
  it("covers the whole grid with a little air around it", () => {
    const tiles = [
      tile(1, 100, 200),
      tile(2, 230, 200),
      tile(3, 360, 200),
      tile(4, 100, 330),
      tile(9, 360, 460),
    ];
    const box = tileGridBox(tiles);
    expect(box.x).toBe(96);
    expect(box.y).toBe(196);
    expect(box.width).toBe(388);
    expect(box.height).toBe(388);
  });

  it("does not ask for a shot from outside the page", () => {
    const box = tileGridBox([tile(1, 2, 1)]);
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
  });
});
