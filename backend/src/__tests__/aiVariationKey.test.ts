// vi.mock calls are hoisted before imports, preventing the DB from opening
vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));

import { describe, it, expect, vi } from "vitest";
import { stripVariationKey, newAiVariation } from "../jobs/checkin";

describe("stripVariationKey", () => {
  it("removes a key the model signed off with", () => {
    expect(stripVariationKey("Just fix the glitch. Thanks. azs5chx0", "azs5chx0")).toBe(
      "Just fix the glitch. Thanks.",
    );
  });

  it("removes a key left on its own line without closing up the paragraphs", () => {
    expect(stripVariationKey("Para one.\n\ndza03xnl\n\nPara two.", "dza03xnl")).toBe(
      "Para one.\n\nPara two.",
    );
  });

  it("removes a key the model bracketed or quoted", () => {
    expect(stripVariationKey("Thanks. [dza03xnl]", "dza03xnl")).toBe("Thanks.");
    expect(stripVariationKey("Thanks. (dza03xnl)", "dza03xnl")).toBe("Thanks.");
  });

  it("leaves a reply that never echoed the key untouched", () => {
    const reply = "I have used this account for two years without any issue.";
    expect(stripVariationKey(reply, "dza03xnl")).toBe(reply);
  });

  it("is a no-op when variation is off and there is no key", () => {
    expect(stripVariationKey("Thanks for looking into it.", undefined)).toBe(
      "Thanks for looking into it.",
    );
  });
});

describe("newAiVariation", () => {
  it("carries the key it put in the directive, so the reply can be stripped of it", () => {
    const variation = newAiVariation();
    expect(variation).toBeDefined();
    expect(variation!.directive).toContain(`[nonce ${variation!.key}:`);
  });

  it("leads with the nonce rather than trailing it, and forbids repeating it", () => {
    const { directive } = newAiVariation()!;
    expect(directive.startsWith("[nonce ")).toBe(true);
    expect(directive).toContain("never repeat the nonce above");
  });
});
