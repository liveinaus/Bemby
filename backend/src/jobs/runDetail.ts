import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths";

// What a run's step log is allowed to cost, and where the pictures in it end up.
//
// A step log carries a JPEG of the page after every step, as a data: URI. That is what makes
// the panel readable, and it is also what made job_logs the whole database: one failed run
// measured 14.7MB across 493 images, because the per-call cap resets for each browser
// session and a job opens one per action. Two things fix it: a budget for the whole run
// rather than per session, and keeping the images as files instead of inside the row.

/**
 * Bytes of images one run's log may keep. A run that spends it all still logs every step;
 * it just stops carrying pictures of them. Sized to leave a row worth reading (roughly a
 * dozen screenshots at the quality they are taken at) without letting one run cost
 * megabytes.
 */
export const MAX_RUN_DETAIL_IMAGE_BYTES = 1_500_000;

/** Where a run's screenshots live once they are off the row. */
function shotsRoot(): string {
  return path.join(dataDir(), "run-shots");
}

function shotsDir(logId: number): string {
  return path.join(shotsRoot(), String(logId));
}

/** data: URIs this stores as files. Anything else is left exactly as it is. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MIMES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const SHOT_REF = /^shot:(\d+)\.(jpg|png|webp)$/;

function parseDataUri(value: unknown): { mime: string; base64: string } | null {
  if (typeof value !== "string") return null;
  const at = value.indexOf(";base64,");
  if (at < 0 || !value.startsWith("data:")) return null;
  return { mime: value.slice(5, at), base64: value.slice(at + 8) };
}

/**
 * Every image in a run's detail, in the order the panel shows them, paired with a way to
 * put something else in its place. Walks whatever shape the detail happens to be: the log
 * types differ per job type and nest (a custom job's actions hold their own web steps), and
 * a walker that only knew today's shapes would quietly stop covering new ones.
 */
type ImageSlot = {
  value: string;
  /** True when the step it belongs to failed, which is the picture worth keeping. */
  onError: boolean;
  replace: (next: string | undefined) => void;
};

function collectImages(node: unknown, onError = false): ImageSlot[] {
  if (Array.isArray(node)) {
    const found: ImageSlot[] = [];
    node.forEach((item, i) => {
      if (typeof item === "string" && parseDataUri(item)) {
        found.push({
          value: item,
          onError,
          replace: (next) => {
            if (next === undefined) node.splice(i, 1, ...[]);
            else node[i] = next;
          },
        });
        return;
      }
      found.push(...collectImages(item, onError));
    });
    return found;
  }
  if (!node || typeof node !== "object") return [];

  const row = node as Record<string, unknown>;
  // A log entry saying it failed marks its own pictures, and its children's
  const failed = onError || Boolean(row.error);
  const found: ImageSlot[] = [];
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (typeof value === "string" && parseDataUri(value)) {
      found.push({
        value,
        onError: failed,
        replace: (next) => {
          if (next === undefined) delete row[key];
          else row[key] = next;
        },
      });
      continue;
    }
    found.push(...collectImages(value, failed));
  }
  return found;
}

/**
 * Drops images past the run's budget, failed steps first in the queue to keep. Returns how
 * many were dropped. The entries themselves stay: a step with no picture still says what it
 * did, which is most of what the log is for.
 */
export function boundRunImages(
  detail: unknown,
  budget = MAX_RUN_DETAIL_IMAGE_BYTES,
): number {
  const slots = collectImages(detail);
  // Failed steps first, then the earliest: the opening steps say how the run started and
  // the failure says how it ended, which is the pair worth having when both cannot fit.
  const order = [...slots.keys()].sort((a, b) => {
    const byError = Number(slots[b].onError) - Number(slots[a].onError);
    return byError !== 0 ? byError : a - b;
  });

  let spent = 0;
  const keep = new Set<number>();
  for (const i of order) {
    const cost = slots[i].value.length;
    if (spent + cost > budget) continue;
    spent += cost;
    keep.add(i);
  }

  let dropped = 0;
  // Back to front, so removing an array entry cannot shift one still to be visited
  for (let i = slots.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    slots[i].replace(undefined);
    dropped++;
  }
  return dropped;
}

/**
 * Writes a run's images out as files and leaves a `shot:<n>.<ext>` reference in their place,
 * so the row holds the text of the run and the pictures sit beside it on disk. Returns the
 * number written. An image that cannot be written stays inline: a log worth less is better
 * than a run reported as failed over a screenshot.
 */
export function externaliseRunImages(logId: number, detail: unknown): number {
  const slots = collectImages(detail);
  if (!slots.length) return 0;

  const dir = shotsDir(logId);
  let written = 0;
  for (const [i, slot] of slots.entries()) {
    const parsed = parseDataUri(slot.value);
    const ext = parsed && EXTENSIONS[parsed.mime];
    if (!parsed || !ext) continue;
    try {
      if (!written) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${i}.${ext}`), Buffer.from(parsed.base64, "base64"));
      slot.replace(`shot:${i}.${ext}`);
      written++;
    } catch (e) {
      console.warn(`[logs] run ${logId} screenshot ${i} stayed in the row:`, e);
    }
  }
  return written;
}

/**
 * Puts the images back where the references are, which is the shape the panel reads. A
 * reference whose file has gone (swept, or the disk lost it) is dropped rather than left as
 * a `shot:` string the panel would try to render.
 */
export function inlineRunImages(logId: number, detail: unknown): unknown {
  if (detail == null) return detail;
  const dir = shotsDir(logId);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const item = node[i];
        const ref = typeof item === "string" ? SHOT_REF.exec(item) : null;
        if (ref) {
          const back = readShot(dir, ref[1], ref[2]);
          if (back) node[i] = back;
          else node.splice(i, 1);
          continue;
        }
        walk(item);
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    const row = node as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      const value = row[key];
      const ref = typeof value === "string" ? SHOT_REF.exec(value) : null;
      if (ref) {
        const back = readShot(dir, ref[1], ref[2]);
        if (back) row[key] = back;
        else delete row[key];
        continue;
      }
      walk(value);
    }
  };
  walk(detail);
  return detail;
}

function readShot(dir: string, seq: string, ext: string): string | undefined {
  try {
    const bytes = fs.readFileSync(path.join(dir, `${seq}.${ext}`));
    return `data:${MIMES[ext] ?? "image/jpeg"};base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/**
 * The detail to store for a run: bounded, with its images moved out of the row. Returns the
 * JSON, or null when the run logged nothing.
 */
export function prepareRunDetail(
  logId: number | bigint | undefined,
  detail: unknown[],
): string | null {
  if (!detail.length) return null;
  const dropped = boundRunImages(detail);
  if (dropped)
    console.log(
      `[logs] run ${logId ?? "?"}: ${dropped} screenshot(s) left out to keep the log small`,
    );
  if (logId !== undefined) externaliseRunImages(Number(logId), detail);
  return JSON.stringify(detail);
}

/** Drops one run's screenshots. */
export function deleteRunShots(logId: number): void {
  try {
    fs.rmSync(shotsDir(logId), { recursive: true, force: true });
  } catch (e) {
    console.warn(`[logs] run ${logId} screenshots not removed:`, e);
  }
}

/**
 * Drops screenshot folders whose run is gone. Deleting a job takes its logs with it through
 * the foreign key, which no amount of care in the delete path can turn into a file sweep, so
 * the files are reconciled against the rows instead.
 */
export function pruneOrphanRunShots(stillLogged: (logId: number) => boolean): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(shotsRoot());
  } catch {
    return 0; // nothing stored yet
  }
  for (const name of entries) {
    const id = Number(name);
    if (!Number.isInteger(id) || stillLogged(id)) continue;
    deleteRunShots(id);
    removed++;
  }
  return removed;
}
