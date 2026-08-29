import {
  cancelBulkAdd,
  clearBulkAdd,
  getBulkAddStatus,
  pauseBulkAdd,
  resumeBulkAdd,
  setBulkAddGap,
} from "./bulkAdd";
import {
  cancelBulkProfile,
  clearBulkProfile,
  getBulkProfileStatus,
  pauseBulkProfile,
  resumeBulkProfile,
  setBulkProfileGap,
} from "./bulkProfile";
import type { BulkTask, BulkTaskItem, BulkTaskItemStatus } from "./bulkTasks";

// The bulk-add and bulk-profile batches predate the generic task runner and keep
// their own retry logic, so they are adapted into the same shape here rather than
// rewritten. That way the panel's task dock lists every piece of background work
// and can terminate any of it.

const ITEM_STATUS: Record<string, BulkTaskItemStatus> = {
  pending: "pending",
  waiting: "waiting",
  paused: "paused",
  done: "done",
  failed: "failed",
  // A created-but-unauthenticated account and an already-authenticated one are
  // both finished work, not failures.
  created: "done",
  skipped: "done",
};

function mapItemStatus(status: string): BulkTaskItemStatus {
  return ITEM_STATUS[status] ?? "working";
}

type LegacyItem = {
  index: number;
  accountId?: number | null;
  accountName?: string | null;
  phoneNumber?: string;
  status: string;
  message: string;
  error: string | null;
};

function adaptItems(items: LegacyItem[]): BulkTaskItem[] {
  return items.map((item) => ({
    index: item.index,
    refId: item.accountId ?? -(item.index + 1),
    refName: item.accountName || item.phoneNumber || `#${item.index + 1}`,
    status: mapItemStatus(item.status),
    // The original status carries detail the generic set does not (e.g. "retrying")
    message: item.message,
    error: item.error,
  }));
}

function adapt(
  batch: {
    id: string;
    createdAt: string;
    running: boolean;
    cancelled: boolean;
    paused: boolean;
    gapSeconds?: number;
    total: number;
    items: LegacyItem[];
  } | null,
  kind: "add" | "profile",
): BulkTask | null {
  if (!batch) return null;
  return {
    id: batch.id,
    kind,
    // One batch of each at a time, so these need no scope of their own
    scope: "",
    label: "",
    createdAt: batch.createdAt,
    finishedAt: batch.running ? null : batch.createdAt,
    state: batch.running ? "running" : batch.cancelled ? "cancelled" : "completed",
    cancelRequested: batch.cancelled,
    paused: batch.paused,
    gapSeconds: batch.gapSeconds ?? 0,
    total: batch.total,
    items: adaptItems(batch.items),
  };
}

/** The legacy batches, in the generic task shape. */
export function legacyBulkTasks(): BulkTask[] {
  return [
    adapt(getBulkAddStatus() as any, "add"),
    adapt(getBulkProfileStatus() as any, "profile"),
  ].filter((t): t is BulkTask => t !== null);
}

/** True when the id belonged to a running legacy batch and it was asked to stop. */
export function cancelLegacyBulkTask(id: string): boolean {
  if (getBulkAddStatus()?.id === id) return cancelBulkAdd();
  if (getBulkProfileStatus()?.id === id) return cancelBulkProfile();
  return false;
}

/** True when the id belonged to a running legacy batch and it was asked to hold. */
export function pauseLegacyBulkTask(id: string): boolean {
  if (getBulkAddStatus()?.id === id) return pauseBulkAdd();
  if (getBulkProfileStatus()?.id === id) return pauseBulkProfile();
  return false;
}

/** True when the id belonged to a paused legacy batch and it was let go on. */
export function resumeLegacyBulkTask(id: string): boolean {
  if (getBulkAddStatus()?.id === id) return resumeBulkAdd();
  if (getBulkProfileStatus()?.id === id) return resumeBulkProfile();
  return false;
}

/** True when the id belonged to a running legacy batch and its gap was changed. */
export function setLegacyBulkTaskGap(id: string, gapSeconds: number): boolean {
  if (getBulkAddStatus()?.id === id) return setBulkAddGap(gapSeconds);
  if (getBulkProfileStatus()?.id === id) return setBulkProfileGap(gapSeconds);
  return false;
}

/** True when the id belonged to a finished legacy batch and it was forgotten. */
export function dismissLegacyBulkTask(id: string): boolean {
  if (getBulkAddStatus()?.id === id) return clearBulkAdd();
  if (getBulkProfileStatus()?.id === id) return clearBulkProfile();
  return false;
}
