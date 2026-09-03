// Splitting a selector from the frames it applies inside. The parse is what decides which
// document a step reaches into, and it runs on every selector, so the case that matters as
// much as the frame ones is the ordinary selector: it has to come through untouched.
vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, expect, it, vi } from "vitest";
import { splitFrameSelector } from "../jobs/cloudflare";

describe("splitFrameSelector", () => {
  it("leaves a selector naming no frame exactly as it was", () => {
    expect(splitFrameSelector("#card-number")).toEqual({ path: [], selector: "#card-number" });
    expect(splitFrameSelector('button:has-text("Pay") >> nth=0')).toEqual({
      path: [],
      selector: 'button:has-text("Pay") >> nth=0',
    });
  });

  it("takes the frame off the front", () => {
    expect(splitFrameSelector("frame:iframe#pay >> #card-number")).toEqual({
      path: ["iframe#pay"],
      selector: "#card-number",
    });
  });

  it("walks a frame within a frame", () => {
    expect(splitFrameSelector("frame:#outer >> frame:#inner >> button.submit")).toEqual({
      path: ["#outer", "#inner"],
      selector: "button.submit",
    });
  });

  // Only the frame half is split on `>>`; whatever follows is the selector, chaining included
  it("leaves the inner selector's own chaining alone", () => {
    expect(splitFrameSelector("frame:#box >> form >> button:visible")).toEqual({
      path: ["#box"],
      selector: "form >> button:visible",
    });
  });

  it("keeps a bare prefix as written, so it reports as matching nothing", () => {
    expect(splitFrameSelector("frame:#box")).toEqual({ path: [], selector: "frame:#box" });
  });
});
