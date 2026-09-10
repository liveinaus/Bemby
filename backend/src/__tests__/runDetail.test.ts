// The weight of a run's step log. A step carries a JPEG of the page after it, and with no
// budget for the whole run one failed job measured 14.7MB across 493 images -- 94% of the
// whole database. What matters here: the budget is honoured, a failed step keeps its
// picture in preference to a working one, the images end up beside the database rather than
// in the row, and what comes back out is what went in.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  boundRunImages,
  externaliseRunImages,
  inlineRunImages,
  prepareRunDetail,
  deleteRunShots,
  pruneOrphanRunShots,
  MAX_RUN_DETAIL_IMAGE_BYTES,
} from "../jobs/runDetail";

let tmpDir: string;
const originalDbPath = process.env.DB_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bemby-run-detail-"));
  process.env.DB_PATH = path.join(tmpDir, "bemby.db");
});

afterEach(() => {
  process.env.DB_PATH = originalDbPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A data: URI of a given length, so a budget can be tested without megabytes of fixture. */
function image(bytes: number, seed = "a"): string {
  return `data:image/jpeg;base64,${seed.repeat(bytes)}`;
}

const shotsDir = (logId: number) => path.join(tmpDir, "run-shots", String(logId));
const shotFiles = (logId: number) => {
  try {
    return fs.readdirSync(shotsDir(logId)).sort();
  } catch {
    return [];
  }
};

describe("boundRunImages", () => {
  it("leaves a run inside its budget untouched", () => {
    const detail = [{ screenshot: image(100) }, { screenshot: image(100) }];
    expect(boundRunImages(detail, 10_000)).toBe(0);
    expect(detail[0].screenshot).toBeDefined();
    expect(detail[1].screenshot).toBeDefined();
  });

  it("drops the images past the budget and keeps the steps themselves", () => {
    const detail = [
      { label: "one", screenshot: image(400) },
      { label: "two", screenshot: image(400) },
      { label: "three", screenshot: image(400) },
    ];
    // Each comes to 423 characters, so a 900 budget has room for two of the three
    expect(boundRunImages(detail, 900)).toBe(1);
    expect(detail).toHaveLength(3);
    expect(detail.map((d) => d.label)).toEqual(["one", "two", "three"]);
    expect(detail.filter((d) => "screenshot" in d)).toHaveLength(2);
    expect("screenshot" in detail[2]).toBe(false); // the earliest are the ones kept
  });

  it("keeps a failed step's picture ahead of a working one", () => {
    const detail = [
      { label: "worked", screenshot: image(500) },
      { label: "worked too", screenshot: image(500) },
      { label: "broke", error: "no such element", screenshot: image(500) },
    ];
    boundRunImages(detail, 600);

    expect("screenshot" in detail[2]).toBe(true); // the failure is the one worth having
    expect("screenshot" in detail[0]).toBe(false);
    expect("screenshot" in detail[1]).toBe(false);
  });

  it("reaches images nested in a custom job's web steps", () => {
    const detail = [
      {
        action: "open_url",
        webSteps: [
          { label: "type", screenshot: image(500) },
          { label: "press", screenshot: image(500), aiImages: [image(500), image(500)] },
        ],
      },
    ];
    const dropped = boundRunImages(detail, 700);
    expect(dropped).toBe(3);
    expect(detail[0].webSteps[0].screenshot).toBeDefined();
    expect(detail[0].webSteps[1].aiImages ?? []).toHaveLength(0);
  });

  it("defaults to a budget that keeps a normal run whole", () => {
    // Twenty screenshots at the size they are actually taken (~40KB of JPEG)
    const detail = Array.from({ length: 20 }, (_, i) => ({
      label: `step ${i}`,
      screenshot: image(55_000),
    }));
    const dropped = boundRunImages(detail);
    expect(dropped).toBe(0);
    expect(MAX_RUN_DETAIL_IMAGE_BYTES).toBeGreaterThan(1_000_000);
  });

  it("bounds the run that caused all this", () => {
    // 493 images, the worst row measured in the wild
    const detail = Array.from({ length: 493 }, () => ({ screenshot: image(30_000) }));
    boundRunImages(detail);

    const bytes = detail.reduce((n, d) => n + (d.screenshot?.length ?? 0), 0);
    expect(bytes).toBeLessThanOrEqual(MAX_RUN_DETAIL_IMAGE_BYTES);
    expect(detail).toHaveLength(493); // every step still logged
  });
});

describe("externaliseRunImages", () => {
  it("writes each image as a file and leaves a reference behind", () => {
    const detail = [{ screenshot: image(60) }, { screenshot: image(60) }];
    expect(externaliseRunImages(7, detail)).toBe(2);

    expect(shotFiles(7)).toEqual(["0.jpg", "1.jpg"]);
    expect(detail[0].screenshot).toBe("shot:0.jpg");
    expect(detail[1].screenshot).toBe("shot:1.jpg");
  });

  it("stores the bytes, not the base64, so the file is smaller than the row was", () => {
    const detail = [{ screenshot: `data:image/jpeg;base64,${Buffer.from("x".repeat(3000)).toString("base64")}` }];
    const inline = detail[0].screenshot.length;
    externaliseRunImages(8, detail);

    const onDisk = fs.statSync(path.join(shotsDir(8), "0.jpg")).size;
    expect(onDisk).toBe(3000);
    expect(onDisk).toBeLessThan(inline);
  });

  it("leaves anything that is not an image it knows alone", () => {
    const detail = [
      { screenshot: "data:application/pdf;base64,AAAA" },
      { outcome: "pressed Login" },
    ];
    expect(externaliseRunImages(9, detail)).toBe(0);
    expect(detail[0].screenshot).toBe("data:application/pdf;base64,AAAA");
    expect(shotFiles(9)).toEqual([]);
  });

  it("comes back exactly as it went in", () => {
    const original = `data:image/jpeg;base64,${Buffer.from("a page, as a picture").toString("base64")}`;
    const detail: any = [{ label: "step", screenshot: original, aiImages: [original] }];
    externaliseRunImages(10, detail);
    expect(detail[0].screenshot).not.toBe(original);

    inlineRunImages(10, detail);
    expect(detail[0].screenshot).toBe(original);
    expect(detail[0].aiImages[0]).toBe(original);
  });

  it("drops a reference whose file has gone rather than showing a broken image", () => {
    const detail: any = [{ label: "step", screenshot: image(60), aiImages: [image(60)] }];
    externaliseRunImages(11, detail);
    fs.rmSync(shotsDir(11), { recursive: true, force: true });

    inlineRunImages(11, detail);
    expect("screenshot" in detail[0]).toBe(false);
    expect(detail[0].aiImages).toHaveLength(0);
    expect(detail[0].label).toBe("step"); // the step is still in the log
  });

  it("passes a detail with no references through untouched", () => {
    const detail = [{ label: "step", screenshot: image(60) }];
    const before = JSON.stringify(detail);
    inlineRunImages(12, detail);
    expect(JSON.stringify(detail)).toBe(before);
  });
});

describe("prepareRunDetail", () => {
  it("bounds, externalises, and hands back the JSON for the row", () => {
    const detail = Array.from({ length: 200 }, () => ({ screenshot: image(30_000) }));
    const json = prepareRunDetail(21, detail);

    expect(json).not.toBeNull();
    // The row is now text and references, a fraction of the six megabytes it held before
    expect(json!.length).toBeLessThan(20_000);
    expect(json).toContain("shot:0.jpg");
    expect(JSON.parse(json!)).toHaveLength(200);
  });

  it("keeps a log with nothing in it out of the row entirely", () => {
    expect(prepareRunDetail(22, [])).toBeNull();
    expect(shotFiles(22)).toEqual([]);
  });

  it("leaves the images inline when there is no row to file them under", () => {
    const detail = [{ screenshot: image(60) }];
    const json = prepareRunDetail(undefined, detail);
    expect(json).toContain("data:image/jpeg;base64,");
  });

  it("round-trips through the row the way the panel reads it", () => {
    const original = `data:image/jpeg;base64,${Buffer.from("the page").toString("base64")}`;
    const json = prepareRunDetail(23, [{ label: "press", screenshot: original }]);

    const asRead = inlineRunImages(23, JSON.parse(json!)) as any[];
    expect(asRead[0]).toEqual({ label: "press", screenshot: original });
  });
});

describe("sweeping screenshots", () => {
  it("drops one run's folder", () => {
    externaliseRunImages(31, [{ screenshot: image(60) }]);
    expect(shotFiles(31)).toHaveLength(1);

    deleteRunShots(31);
    expect(fs.existsSync(shotsDir(31))).toBe(false);
  });

  it("is quiet about a run that never had any", () => {
    expect(() => deleteRunShots(999)).not.toThrow();
  });

  it("drops folders whose run is gone and keeps the rest", () => {
    for (const id of [41, 42, 43]) externaliseRunImages(id, [{ screenshot: image(60) }]);

    const live = new Set([42]);
    expect(pruneOrphanRunShots((id) => live.has(id))).toBe(2);

    expect(fs.existsSync(shotsDir(41))).toBe(false);
    expect(fs.existsSync(shotsDir(42))).toBe(true);
    expect(fs.existsSync(shotsDir(43))).toBe(false);
  });

  it("is quiet when nothing has been stored yet", () => {
    expect(pruneOrphanRunShots(() => true)).toBe(0);
  });
});
