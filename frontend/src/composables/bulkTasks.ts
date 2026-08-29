import { computed, ref } from "vue";
import { bulkTasksApi, type BulkTask, type BulkTaskKind } from "../api/client";

// Module-level singleton mirroring the server's background bulk tasks. The dock in
// App.vue and every view that starts a task read the same list, so progress shows
// up wherever the operator happens to be -- including after a page reload, since
// the work itself lives on the server.

const RUNNING_POLL_MS = 1500;
const IDLE_POLL_MS = 15000;

const tasks = ref<BulkTask[]>([]);

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;

/** Kinds whose task finished since the last poll, so views can reload their data. */
const finishListeners = new Set<(task: BulkTask) => void>();
let previousStates = new Map<string, BulkTask["state"]>();

export const runningTasks = computed(() =>
  tasks.value.filter((t) => t.state === "running"),
);

export function taskProgress(task: BulkTask): number {
  const settled = task.items.filter(
    (i) => i.status === "done" || i.status === "failed" || i.status === "cancelled",
  ).length;
  return task.total ? Math.round((settled / task.total) * 100) : 0;
}

export function taskDoneCount(task: BulkTask): number {
  return task.items.filter((i) => i.status === "done" || i.status === "failed")
    .length;
}

export function taskFailedCount(task: BulkTask): number {
  return task.items.filter((i) => i.status === "failed").length;
}

export function runningTaskOfKind(kind: BulkTaskKind): BulkTask | null {
  return tasks.value.find((t) => t.kind === kind && t.state === "running") ?? null;
}

/** The running queue that already holds any of these items, e.g. the jobs just selected. */
export function runningTaskWithRef(
  kind: BulkTaskKind,
  refIds: number[],
): BulkTask | null {
  const wanted = new Set(refIds);
  return (
    tasks.value.find(
      (t) =>
        t.kind === kind &&
        t.state === "running" &&
        t.items.some((i) => wanted.has(i.refId)),
    ) ?? null
  );
}

export function taskById(id: string | null): BulkTask | null {
  if (!id) return null;
  return tasks.value.find((t) => t.id === id) ?? null;
}

/** Fires the finish callbacks for tasks that stopped running since the last poll. */
function reportFinished(next: BulkTask[]): void {
  for (const task of next) {
    const before = previousStates.get(task.id);
    if (before === "running" && task.state !== "running") {
      for (const listener of finishListeners) listener(task);
    }
  }
  previousStates = new Map(next.map((t) => [t.id, t.state]));
}

/** Calls back once per task that stops running; returns an unsubscribe function. */
export function onBulkTaskFinished(
  listener: (task: BulkTask) => void,
): () => void {
  finishListeners.add(listener);
  return () => finishListeners.delete(listener);
}

async function refreshBulkTasks(): Promise<void> {
  const next = await bulkTasksApi.list();
  tasks.value = next;
  reportFinished(next);
}

function scheduleNextPoll(): void {
  if (!polling) return;
  if (pollTimer) clearTimeout(pollTimer);
  const delay = runningTasks.value.length ? RUNNING_POLL_MS : IDLE_POLL_MS;
  pollTimer = setTimeout(tick, delay);
}

async function tick(): Promise<void> {
  try {
    await refreshBulkTasks();
  } catch {
    // Transient failure (offline, restart): the next tick tries again
  }
  scheduleNextPoll();
}

/** Starts the shared poll loop. Safe to call from any view; only the first call arms it. */
export function startBulkTaskPolling(): void {
  if (polling) return;
  polling = true;
  void tick();
}

/** Used by tests and teardown; the dock itself keeps the loop for the session. */
export function stopBulkTaskPolling(): void {
  polling = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

/** Pulls the list forward now, e.g. right after starting a task. */
export function pokeBulkTasks(): void {
  if (!polling) {
    startBulkTaskPolling();
    return;
  }
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(tick, 200);
}

/** Records a task the caller just started, so the UI reacts before the next poll. */
export function trackStartedTask(task: BulkTask): void {
  tasks.value = [task, ...tasks.value.filter((t) => t.id !== task.id)];
  previousStates.set(task.id, task.state);
  pokeBulkTasks();
}

export async function cancelBulkTask(id: string): Promise<void> {
  await bulkTasksApi.cancel(id);
  pokeBulkTasks();
}

/** Holds a queue after the item in flight; the card flips over before the next poll. */
export async function pauseBulkTask(id: string): Promise<void> {
  await bulkTasksApi.pause(id);
  setPaused(id, true);
}

export async function resumeBulkTask(id: string): Promise<void> {
  await bulkTasksApi.resume(id);
  setPaused(id, false);
}

function setPaused(id: string, paused: boolean): void {
  tasks.value = tasks.value.map((t) => (t.id === id ? { ...t, paused } : t));
  pokeBulkTasks();
}

/**
 * Changes the wait between items. The server clamps the value and hands back what it
 * kept, so the card shows the gap that is actually in force.
 */
export async function setBulkTaskGap(
  id: string,
  gapSeconds: number,
): Promise<number> {
  const { gapSeconds: applied } = await bulkTasksApi.setGap(id, gapSeconds);
  tasks.value = tasks.value.map((t) =>
    t.id === id ? { ...t, gapSeconds: applied } : t,
  );
  pokeBulkTasks();
  return applied;
}

export async function dismissBulkTask(id: string): Promise<void> {
  await bulkTasksApi.dismiss(id);
  tasks.value = tasks.value.filter((t) => t.id !== id);
  previousStates.delete(id);
}

export { tasks as bulkTasks };
