// Uploaded icons are operator-supplied files referenced by name from a config blob, so both
// ends are untrusted: the bytes claiming to be an image, and the reference claiming to name
// one. A reference that escapes the icon directory would be a file read primitive.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import {
  deleteJobIcon,
  isKnownIcon,
  jobIconDataUrl,
  jobIconDir,
  listJobIcons,
  saveJobIcon,
} from "../jobs/jobIcons";

const root = mkdtempSync(path.join(os.tmpdir(), "jobicons-"));
const icons = path.join(root, "job-icons");

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');

beforeEach(() => {
  process.env.DB_PATH = path.join(root, "bemby.db");
  delete process.env.BEMBY_JOB_ICON_DIR;
  rmSync(icons, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

describe("jobIconDir", () => {
  it("sits beside the database, and is overridable", () => {
    expect(jobIconDir()).toBe(icons);
    process.env.BEMBY_JOB_ICON_DIR = "/srv/icons";
    expect(jobIconDir()).toBe("/srv/icons");
  });
});

describe("saveJobIcon", () => {
  it("names the file by content, so the same upload twice is one file", () => {
    const first = saveJobIcon(PNG);
    const second = saveJobIcon(PNG);
    expect(first.name).toBe(second.name);
    expect(readdirSync(icons)).toHaveLength(1);
    expect(first.name.endsWith(".png")).toBe(true);
  });

  it("takes the extension from the bytes, not from anyone's claim", () => {
    expect(saveJobIcon(SVG).name.endsWith(".svg")).toBe(true);
  });

  it("refuses what is not an image it can serve", () => {
    expect(() => saveJobIcon(Buffer.from("#!/bin/sh\nrm -rf /"))).toThrow(/PNG, JPEG/);
    expect(() => saveJobIcon(Buffer.alloc(0))).toThrow(/empty/i);
  });
});

describe("listJobIcons", () => {
  it("returns nothing before anything has been uploaded", () => {
    expect(listJobIcons()).toEqual([]);
  });

  it("ignores files that are not icons", () => {
    mkdirSync(icons, { recursive: true });
    writeFileSync(path.join(icons, "a.png"), PNG);
    writeFileSync(path.join(icons, "notes.txt"), "hello");
    writeFileSync(path.join(icons, ".hidden.png"), PNG);
    expect(listJobIcons().map((f) => f.name)).toEqual(["a.png"]);
  });
});

describe("jobIconDataUrl", () => {
  it("encodes the file with the mime type the panel needs to render it", () => {
    const file = saveJobIcon(PNG);
    expect(jobIconDataUrl(file)?.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("isKnownIcon", () => {
  it("accepts an icon-font class name", () => {
    expect(isKnownIcon("fa-solid fa-gift")).toBe(true);
  });

  it("rejects a font name carrying anything that could break out of a class attribute", () => {
    expect(isKnownIcon('fa" onload="alert(1)')).toBe(false);
    expect(isKnownIcon("fa-solid<script>")).toBe(false);
    expect(isKnownIcon("")).toBe(false);
  });

  it("accepts a custom reference only while the file is really there", () => {
    const file = saveJobIcon(PNG);
    expect(isKnownIcon(`custom:${file.name}`)).toBe(true);
    deleteJobIcon(file.name);
    expect(isKnownIcon(`custom:${file.name}`)).toBe(false);
  });

  it("refuses a reference that climbs out of the icon directory", () => {
    expect(isKnownIcon("custom:../../bemby.db")).toBe(false);
    expect(isKnownIcon("custom:/etc/passwd")).toBe(false);
    expect(isKnownIcon("custom:..%2Fbemby.db")).toBe(false);
  });
});

describe("deleteJobIcon", () => {
  it("removes an icon and refuses a name that is not one", () => {
    const file = saveJobIcon(PNG);
    expect(deleteJobIcon(file.name)).toBe(true);
    expect(listJobIcons()).toEqual([]);
    expect(deleteJobIcon("../bemby.db")).toBe(false);
    expect(deleteJobIcon("never-existed.png")).toBe(false);
  });
});
