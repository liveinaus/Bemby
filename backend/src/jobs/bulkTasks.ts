import crypto from "crypto";

// Server-side runner for the long bulk actions the panel used to drive from the
// browser (spam checks, credential changes, job runs, ...). The page starts a
// task and may then be closed: the server works through the items one at a time,
// progress is polled back over /api/bulk-tasks, and a running task can be
// terminated. Tasks live in memory only, so a server restart ends them -- the
// same trade-off the bulk-add and bulk-profile batches already make.

export type BulkTaskKind =
  | "spam-check"
  | "fetch-attributes"
  | "login-email"
  | "credentials"
  | "passkey"
  | "privacy"
  | "clean"
  | "run-jobs"
  // Run by their own older batch runners and surfaced through jobs/bulkTaskBridge
  | "add"
  | "profile";

export type BulkTaskItemStatus =
  | "pending"
  | "waiting"
  | "working"
  | "done"
  | "failed"
  | "cancelled";

export type BulkTaskState = "running" | "completed" | "cancelled";

export type BulkTaskItem = {
  index: number;
  /** Account id, or job id for "run-jobs". */
  refId: number;
  refName: string;
  status: BulkTaskItemStatus;
  message: string;
  error: string | null;
  /** Op-specific result, so the UI can render it in its own wording. */
  data?: Record<string, unknown>;
};

export type BulkTask = {
  id: string;
  kind: BulkTaskKind;
  createdAt: string;
  finishedAt: string | null;
  state: BulkTaskState;
  cancelRequested: boolean;
  gapSeconds: number;
  total: number;
  items: BulkTaskItem[];
};

export type BulkTaskEntry = { refId: number; refName: string };

export type BulkTaskContext = {
  /** True once termination was requested; slow handlers should bail out. */
  cancelled: () => boolean;
  /** Sleep that returns early when the task is terminated. */
  sleep: (ms: number) => Promise<void>;
  /** Progress line shown against the item while it is still working. */
  progress: (message: string) => void;
};

/**
 * A handler that was interrupted by a termination request throws this, so the item
 * reads as terminated rather than as a genuine failure.
 */
export const TERMINATED = "Terminated";

export type BulkTaskItemResult =
  | { message?: string; data?: Record<string, unknown> }
  | string
  | void;

export type BulkTaskHandler = (
  item: BulkTaskItem,
  ctx: BulkTaskContext,
) => Promise<BulkTaskItemResult>;

export type StartBulkTaskInput = {
  kind: BulkTaskKind;
  entries: BulkTaskEntry[];
  /** Pause between items, in seconds; spaces out Telegram calls. */
  gapSeconds?: number;
  handler: BulkTaskHandler;
};

export type StartBulkTaskResult =
  | { ok: true; task: BulkTask }
  | { ok: false; error: string };

/** Finished tasks are kept this long so the panel can still show the outcome. */
const FINISHED_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_FINISHED = 20;

const tasks = new Map<string, BulkTask>();

const KIND_LABELS: Record<BulkTaskKind, string> = {
  "spam-check": "spam check",
  "fetch-attributes": "attribute refresh",
  "login-email": "login email change",
  credentials: "credential change",
  passkey: "passkey",
  privacy: "privacy lockdown",
  clean: "clean",
  "run-jobs": "job run",
  add: "bulk add",
  profile: "profile update",
};

function normaliseGap(gapSeconds: unknown, fallback: number): number {
  const gap = Number(gapSeconds);
  return Number.isFinite(gap) && gap >= 0 ? gap : fallback;
}

// Abortable sleep -- resolves early once termination is requested.
function sleep(ms: number, task: BulkTask): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (task.cancelRequested || Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(1000, ms));
    };
    tick();
  });
}

function pruneFinished(): void {
  const finished = [...tasks.values()]
    .filter((t) => t.state !== "running")
    .sort((a, b) =>
      (a.finishedAt ?? a.createdAt).localeCompare(b.finishedAt ?? b.createdAt),
    );
  const cutoff = Date.now() - FINISHED_TTL_MS;
  const kept: BulkTask[] = [];
  for (const task of finished) {
    if (Date.parse(task.finishedAt ?? task.createdAt) < cutoff) {
      tasks.delete(task.id);
    } else {
      kept.push(task);
    }
  }
  // Oldest first, so the slice drops the oldest beyond the cap
  for (const task of kept.slice(0, Math.max(0, kept.length - MAX_FINISHED))) {
    tasks.delete(task.id);
  }
}

/** Newest first, so the panel lists what is running (or just ran) at the top. */
export function listBulkTasks(): BulkTask[] {
  pruneFinished();
  return [...tasks.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export function getBulkTask(id: string): BulkTask | null {
  return tasks.get(id) ?? null;
}

export function runningTaskOfKind(kind: BulkTaskKind): BulkTask | null {
  for (const task of tasks.values()) {
    if (task.kind === kind && task.state === "running") return task;
  }
  return null;
}

/** Asks a running task to stop after the item in flight; false if it had finished. */
export function cancelBulkTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.state !== "running") return false;
  task.cancelRequested = true;
  return true;
}

/** Drops a finished task from the list; a running task must be terminated first. */
export function dismissBulkTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.state === "running") return false;
  tasks.delete(id);
  return true;
}

/** Test seam: forget every task. */
export function resetBulkTasks(): void {
  tasks.clear();
}

async function runTask(task: BulkTask, handler: BulkTaskHandler): Promise<void> {
  const gapMs = task.gapSeconds * 1000;
  try {
    let processedAny = false;
    for (const item of task.items) {
      if (task.cancelRequested) break;

      // The gap spaces successive calls, so it belongs between two items.
      if (processedAny && gapMs > 0) {
        item.status = "waiting";
        item.message = `Waiting ${Math.round(gapMs / 1000)}s`;
        await sleep(gapMs, task);
        if (task.cancelRequested) break;
      }
      processedAny = true;

      item.status = "working";
      item.message = "";
      try {
        const result = await handler(item, {
          cancelled: () => task.cancelRequested,
          sleep: (ms) => sleep(ms, task),
          progress: (message) => {
            if (item.status === "working") item.message = message;
          },
        });
        const normalised =
          typeof result === "string" ? { message: result } : (result ?? {});
        item.status = "done";
        item.message = normalised.message ?? "";
        item.data = normalised.data;
        item.error = null;
      } catch (err: any) {
        const reason = err?.errorMessage ?? err?.message ?? String(err);
        if (task.cancelRequested && reason === TERMINATED) {
          item.status = "cancelled";
          item.message = TERMINATED;
          item.error = null;
        } else {
          item.status = "failed";
          item.error = reason;
          item.message = reason;
        }
      }
    }
  } finally {
    // Anything not reached (or interrupted) reads as terminated, not pending.
    for (const item of task.items) {
      if (item.status !== "done" && item.status !== "failed") {
        item.status = "cancelled";
        item.message = "Terminated";
      }
    }
    task.state = task.cancelRequested ? "cancelled" : "completed";
    task.finishedAt = new Date().toISOString();
    pruneFinished();
  }
}

export function startBulkTask(input: StartBulkTaskInput): StartBulkTaskResult {
  const running = runningTaskOfKind(input.kind);
  if (running) {
    return {
      ok: false,
      error: `A background ${KIND_LABELS[input.kind]} task is already running`,
    };
  }
  if (!Array.isArray(input.entries) || !input.entries.length) {
    return { ok: false, error: "No items provided" };
  }

  const task: BulkTask = {
    id: crypto.randomUUID(),
    kind: input.kind,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    state: "running",
    cancelRequested: false,
    gapSeconds: normaliseGap(input.gapSeconds, 0),
    total: input.entries.length,
    items: input.entries.map((entry, index) => ({
      index,
      refId: entry.refId,
      refName: entry.refName,
      status: "pending",
      message: "",
      error: null,
    })),
  };
  tasks.set(task.id, task);
  pruneFinished();
  void runTask(task, input.handler);
  return { ok: true, task };
}
