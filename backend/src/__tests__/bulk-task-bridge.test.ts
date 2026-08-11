// The bulk-add and bulk-profile batches keep their own runners; this checks the
// adapter that presents them in the same shape as the generic background tasks,
// so one panel can list and terminate every kind of background work.

const mocks = vi.hoisted(() => ({
  getBulkAddStatus: vi.fn(),
  cancelBulkAdd: vi.fn(() => true),
  clearBulkAdd: vi.fn(() => true),
  getBulkProfileStatus: vi.fn(),
  cancelBulkProfile: vi.fn(() => true),
  clearBulkProfile: vi.fn(() => true),
}));

vi.mock("../jobs/bulkAdd", () => ({
  getBulkAddStatus: mocks.getBulkAddStatus,
  cancelBulkAdd: mocks.cancelBulkAdd,
  clearBulkAdd: mocks.clearBulkAdd,
  isBulkAccountManagementEnabled: () => true,
}));
vi.mock("../jobs/bulkProfile", () => ({
  getBulkProfileStatus: mocks.getBulkProfileStatus,
  cancelBulkProfile: mocks.cancelBulkProfile,
  clearBulkProfile: mocks.clearBulkProfile,
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cancelLegacyBulkTask,
  dismissLegacyBulkTask,
  legacyBulkTasks,
} from "../jobs/bulkTaskBridge";

const addBatch = {
  id: "add-1",
  createdAt: "2026-08-05T00:00:00.000Z",
  running: true,
  cancelled: false,
  total: 5,
  items: [
    { index: 0, phoneNumber: "+1", accountId: 7, accountName: "A_7", status: "done", message: "Authenticated", error: null },
    { index: 1, phoneNumber: "+2", accountId: 8, accountName: "A_8", status: "created", message: "Added without authentication", error: null },
    { index: 2, phoneNumber: "+3", accountId: 9, accountName: "A_9", status: "skipped", message: "Already authenticated", error: null },
    { index: 3, phoneNumber: "+4", accountId: null, accountName: null, status: "retrying", message: "Attempt 1/3 failed", error: null },
    { index: 4, phoneNumber: "+5", accountId: 11, accountName: "A_11", status: "failed", message: "Failed", error: "boom" },
  ],
};

const profileBatch = {
  id: "profile-1",
  createdAt: "2026-08-05T01:00:00.000Z",
  running: false,
  cancelled: true,
  total: 2,
  items: [
    { index: 0, accountId: 1, accountName: "A_1", status: "done", message: "Profile updated", error: null },
    { index: 1, accountId: 2, accountName: "A_2", status: "pending", message: "", error: null },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBulkAddStatus.mockReturnValue(null);
  mocks.getBulkProfileStatus.mockReturnValue(null);
});

describe("legacyBulkTasks", () => {
  it("returns nothing when neither batch has ever run", () => {
    expect(legacyBulkTasks()).toEqual([]);
  });

  it("maps a running bulk-add batch onto the generic task shape", () => {
    mocks.getBulkAddStatus.mockReturnValue(addBatch);
    const [task] = legacyBulkTasks();

    expect(task).toMatchObject({
      id: "add-1",
      kind: "add",
      state: "running",
      finishedAt: null,
      cancelRequested: false,
      total: 5,
    });
    // created/skipped are finished work, retrying is still in flight
    expect(task.items.map((i) => i.status)).toEqual([
      "done",
      "done",
      "done",
      "working",
      "failed",
    ]);
    // The original wording is kept, since the generic status set is coarser
    expect(task.items[3].message).toBe("Attempt 1/3 failed");
    expect(task.items[4].error).toBe("boom");
  });

  it("labels an item by account name, falling back to the phone number", () => {
    mocks.getBulkAddStatus.mockReturnValue(addBatch);
    const [task] = legacyBulkTasks();
    expect(task.items[0].refName).toBe("A_7");
    expect(task.items[3].refName).toBe("+4");
    // An account that does not exist yet still needs a distinct key for the UI
    expect(task.items[3].refId).not.toBe(task.items[0].refId);
  });

  it("reports a cancelled batch as terminated and a finished one as completed", () => {
    mocks.getBulkProfileStatus.mockReturnValue(profileBatch);
    const [cancelledTask] = legacyBulkTasks();
    expect(cancelledTask.kind).toBe("profile");
    expect(cancelledTask.state).toBe("cancelled");
    expect(cancelledTask.finishedAt).not.toBeNull();

    mocks.getBulkProfileStatus.mockReturnValue({ ...profileBatch, cancelled: false });
    expect(legacyBulkTasks()[0].state).toBe("completed");
  });

  it("lists both batches when both exist", () => {
    mocks.getBulkAddStatus.mockReturnValue(addBatch);
    mocks.getBulkProfileStatus.mockReturnValue(profileBatch);
    expect(legacyBulkTasks().map((t) => t.kind)).toEqual(["add", "profile"]);
  });
});

// A finished batch used to have no way out of the list: the panel cleared only its own
// view, and the next poll handed the same batch straight back.
describe("dismissLegacyBulkTask", () => {
  it("forgets the batch the id belongs to, and only that one", () => {
    mocks.getBulkAddStatus.mockReturnValue(addBatch);
    mocks.getBulkProfileStatus.mockReturnValue(profileBatch);

    expect(dismissLegacyBulkTask("profile-1")).toBe(true);
    expect(mocks.clearBulkProfile).toHaveBeenCalledTimes(1);
    expect(mocks.clearBulkAdd).not.toHaveBeenCalled();
  });

  it("passes on an id that belongs to neither, so the generic tasks get a turn", () => {
    mocks.getBulkAddStatus.mockReturnValue(addBatch);
    expect(dismissLegacyBulkTask("some-generic-task")).toBe(false);
    expect(mocks.clearBulkAdd).not.toHaveBeenCalled();
  });

  it("reports the runner's refusal to clear a batch still running", () => {
    mocks.getBulkAddStatus.mockReturnValue(addBatch);
    mocks.clearBulkAdd.mockReturnValueOnce(false);
    expect(dismissLegacyBulkTask("add-1")).toBe(false);
  });
});

describe("cancelLegacyBulkTask", () => {
  it("routes the id to the batch that owns it", () => {
    mocks.getBulkAddStatus.mockReturnValue(addBatch);
    mocks.getBulkProfileStatus.mockReturnValue(profileBatch);

    expect(cancelLegacyBulkTask("add-1")).toBe(true);
    expect(mocks.cancelBulkAdd).toHaveBeenCalledTimes(1);
    expect(mocks.cancelBulkProfile).not.toHaveBeenCalled();

    expect(cancelLegacyBulkTask("profile-1")).toBe(true);
    expect(mocks.cancelBulkProfile).toHaveBeenCalledTimes(1);
  });

  it("ignores an id that belongs to neither", () => {
    mocks.getBulkAddStatus.mockReturnValue(addBatch);
    expect(cancelLegacyBulkTask("something-else")).toBe(false);
    expect(mocks.cancelBulkAdd).not.toHaveBeenCalled();
  });

  it("passes on the runner's answer when the batch had already stopped", () => {
    mocks.getBulkAddStatus.mockReturnValue({ ...addBatch, running: false });
    mocks.cancelBulkAdd.mockReturnValue(false);
    expect(cancelLegacyBulkTask("add-1")).toBe(false);
  });
});
