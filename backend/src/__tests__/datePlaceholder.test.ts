// A matcher may name the date the run is happening on, so a bot that answers with today's
// date is still matched by a job that was set up months ago.

import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { getDefaultTimezone } from "../db/database";
import {
  expandCommand,
  expandDatePlaceholders,
  parseLabelAlternatives,
  textSaysFail,
  textSaysSuccess,
} from "../jobs/placeholders";

const AT = DateTime.fromISO("2026-08-28T09:05:00", { zone: "Australia/Sydney" });

/** What a matcher expands to right now -- the app's timezone, which is what the code reads. */
function today(format: string): string {
  return DateTime.now().setZone(getDefaultTimezone()).toFormat(format);
}

describe("expandDatePlaceholders", () => {
  it("defaults to ISO when no format is given", () => {
    expect(expandDatePlaceholders("{date}", AT)).toBe("2026-08-28");
  });

  it("takes the format the user wrote", () => {
    expect(expandDatePlaceholders("{date:d/M/yyyy}", AT)).toBe("28/8/2026");
    expect(expandDatePlaceholders("{date:dd-MM-yy}", AT)).toBe("28-08-26");
    expect(expandDatePlaceholders("{date:yyyy年M月d日}", AT)).toBe("2026年8月28日");
    expect(expandDatePlaceholders("{date:MMMM d, yyyy}", AT)).toBe("August 28, 2026");
  });

  // Sites differ on this and nothing else, so the doubled token has to be the whole answer
  it("tells a padded number from an unpadded one", () => {
    expect(expandDatePlaceholders("{date:dd/MM/yyyy}", AT)).toBe("28/08/2026");
    expect(expandDatePlaceholders("{date:d/M/yyyy}", AT)).toBe("28/8/2026");
  });

  it("takes time tokens too", () => {
    expect(expandDatePlaceholders("{date:HH:mm}", AT)).toBe("09:05");
  });

  it("expands every occurrence and keeps the surrounding text", () => {
    expect(expandDatePlaceholders("签到成功 {date:d/M/yyyy} 至 {date:d/M/yyyy}", AT)).toBe(
      "签到成功 28/8/2026 至 28/8/2026",
    );
  });

  it("ignores whitespace around the format", () => {
    expect(expandDatePlaceholders("{date: d/M/yyyy }", AT)).toBe("28/8/2026");
  });

  it("leaves text with no placeholder alone", () => {
    expect(expandDatePlaceholders("签到成功", AT)).toBe("签到成功");
    expect(expandDatePlaceholders("{word:4}", AT)).toBe("{word:4}");
  });

  it("leaves a format carrying | alone, since | separates alternatives", () => {
    expect(expandDatePlaceholders("{date:d|M}", AT)).toBe("{date:d|M}");
  });
});

describe("date placeholders in matchers", () => {
  it("splits alternatives after expanding", () => {
    expect(parseLabelAlternatives("签到成功|{date:d/M/yyyy}")).toEqual([
      "签到成功",
      today("d/M/yyyy"),
    ]);
  });

  it("matches a reply carrying today's date", () => {
    expect(textSaysSuccess(`签到成功 ${today("d/M/yyyy")}`, "{date:d/M/yyyy}")).toBe(true);
    expect(textSaysSuccess("签到成功 1/1/2000", "{date:d/M/yyyy}")).toBe(false);
    expect(textSaysFail(`已签到 ${today("d/M/yyyy")}`, "已签到 {date:d/M/yyyy}")).toBe(true);
  });

  // One field covers a site whose wording you are not sure of yet
  it("takes one alternative per format", () => {
    const wanted = "{date:d/M/yyyy}|{date:dd/MM/yyyy}|{date:yyyy-MM-dd}";
    expect(textSaysSuccess(`签到成功 ${today("dd/MM/yyyy")}`, wanted)).toBe(true);
    expect(textSaysSuccess(`签到成功 ${today("yyyy-MM-dd")}`, wanted)).toBe(true);
  });
});

describe("date placeholders in expandCommand", () => {
  it("expands alongside the random placeholders", () => {
    expect(expandCommand("/checkin {date}")).toBe(`/checkin ${today("yyyy-MM-dd")}`);
  });

  it("lets a named context value win", () => {
    expect(expandCommand("{date}", { date: "custom" })).toBe("custom");
  });
});
