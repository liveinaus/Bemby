// The icon shares the config column with job-type settings, so the merge is the whole
// safety story: a job form that knows nothing about icons saves config on every edit, and
// must not take the icon with it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const knownIcons = vi.hoisted(() => ({ set: new Set<string>() }));
vi.mock("../jobs/jobIcons", () => ({
  isKnownIcon: (icon: string) => knownIcons.set.has(icon),
}));

import { iconFromConfig, mergeIconIntoConfig, stripIcon } from "../jobs/configIcon";

beforeEach(() => {
  knownIcons.set = new Set(["fa-solid fa-gift", "custom:a1b2.png"]);
});

const parse = (raw: string | null) => (raw ? JSON.parse(raw) : null);

describe("iconFromConfig", () => {
  it("reads the icon out of a stored config", () => {
    expect(iconFromConfig('{"icon":"fa-solid fa-gift","steps":[]}')).toBe("fa-solid fa-gift");
  });

  it("returns null for config without one, empty config, or unparseable text", () => {
    expect(iconFromConfig('{"steps":[]}')).toBeNull();
    expect(iconFromConfig(null)).toBeNull();
    expect(iconFromConfig("not json")).toBeNull();
  });

  it("copes with the double-encoded rows some configs were written as", () => {
    expect(iconFromConfig(JSON.stringify('{"icon":"fa-solid fa-gift"}'))).toBe(
      "fa-solid fa-gift",
    );
  });
});

describe("stripIcon", () => {
  it("removes the key so a client cannot set an icon through config", () => {
    expect(stripIcon({ icon: "fa-solid fa-bug", steps: [1] })).toEqual({ steps: [1] });
  });

  it("passes non-objects through untouched", () => {
    expect(stripIcon(null)).toBeNull();
    expect(stripIcon("text")).toBe("text");
  });
});

describe("mergeIconIntoConfig", () => {
  it("keeps the stored icon when the request says nothing about icons", () => {
    const stored = '{"icon":"fa-solid fa-gift","steps":[1]}';
    const next = mergeIconIntoConfig({ steps: [2] }, stored, undefined);
    expect(parse(next)).toEqual({ steps: [2], icon: "fa-solid fa-gift" });
  });

  it("clears the icon only when asked to explicitly", () => {
    const stored = '{"icon":"fa-solid fa-gift","steps":[1]}';
    expect(parse(mergeIconIntoConfig({ steps: [1] }, stored, null))).toEqual({ steps: [1] });
  });

  it("keeps the stored config when no new config is supplied", () => {
    const stored = '{"steps":[1,2,3]}';
    const next = mergeIconIntoConfig(undefined, stored, "fa-solid fa-gift");
    expect(parse(next)).toEqual({ steps: [1, 2, 3], icon: "fa-solid fa-gift" });
  });

  it("refuses an icon that is not one we know about", () => {
    // A custom reference whose file has been deleted would otherwise render a hole
    const next = mergeIconIntoConfig({ steps: [] }, null, "custom:deleted.png");
    expect(parse(next)).toEqual({ steps: [] });
  });

  it("ignores an icon smuggled in through config", () => {
    const next = mergeIconIntoConfig(
      { steps: [], icon: "custom:a1b2.png" },
      null,
      undefined,
    );
    expect(parse(next)).toEqual({ steps: [] });
  });

  it("stores null rather than an empty object, matching the column's old behaviour", () => {
    expect(mergeIconIntoConfig({}, null, undefined)).toBeNull();
    expect(mergeIconIntoConfig(null, null, null)).toBeNull();
  });

  it("clears the config but keeps the icon when config is explicitly null", () => {
    const stored = '{"icon":"fa-solid fa-gift","steps":[1]}';
    expect(parse(mergeIconIntoConfig(null, stored, undefined))).toEqual({
      icon: "fa-solid fa-gift",
    });
  });
});
