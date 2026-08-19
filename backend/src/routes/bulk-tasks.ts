import { Router } from "express";
import { bulkMgmtGuard } from "../middleware/bulkMgmt";
import {
  cancelBulkTask,
  dismissBulkTask,
  getBulkTask,
  listBulkTasks,
  type StartBulkTaskResult,
} from "../jobs/bulkTasks";
import {
  cancelLegacyBulkTask,
  dismissLegacyBulkTask,
  legacyBulkTasks,
} from "../jobs/bulkTaskBridge";
import {
  startBulkClean,
  startBulkCredentials,
  startBulkExtractMessages,
  startBulkFetchAttributes,
  startBulkJobRuns,
  startBulkLoginEmail,
  startBulkPasskey,
  startBulkPrivacy,
  startBulkSpamCheck,
  type BulkExtractInput,
} from "../jobs/bulkOps";
import {
  dropExtractResults,
  getExtractResults,
  pruneExtractResults,
  EXTRACT_PLACEHOLDERS,
} from "../jobs/bulkExtract";
import { msApiConfigured, msApiOffReason } from "../jobs/msOauth2api";
import {
  allNarrowest,
  isPrivacyLevel,
  PRIVACY_KEYS,
  type PrivacySelection,
} from "../tg/privacy";

// Background bulk tasks: the panel starts one, polls this list for progress and
// may terminate it. Task objects carry no secrets -- passwords and Gmail app
// passwords stay in the runner's closure.

const router = Router();

function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

function optionalSeconds(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function respond(res: import("express").Response, result: StartBulkTaskResult): void {
  if (!result.ok) {
    // 409 carries the queue already holding this scope, so the panel can show it
    // instead of leaving the operator to guess what is in the way.
    const status = result.conflictTaskId ? 409 : 400;
    res.status(status).json({ error: result.error, taskId: result.conflictTaskId });
    return;
  }
  res.status(201).json(result.task);
}

// GET / -- every running task plus recently finished ones, newest first
router.get("/", (_req, res) => {
  const own = listBulkTasks();
  // Extraction lines outlive nothing: a task the list has pruned takes its results with it
  pruneExtractResults(new Set(own.map((t) => t.id)));
  const tasks = [...own, ...legacyBulkTasks()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  res.json({ tasks });
});

router.get("/:id", (req, res) => {
  const task =
    getBulkTask(req.params.id) ??
    legacyBulkTasks().find((t) => t.id === req.params.id) ??
    null;
  if (!task) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(task);
});

// POST /:id/cancel -- stop after the item currently in flight
router.post("/:id/cancel", (req, res) => {
  const cancelled =
    cancelBulkTask(req.params.id) || cancelLegacyBulkTask(req.params.id);
  res.json({ cancelled });
});

// DELETE /:id -- drop a finished task from the list
router.delete("/:id", (req, res) => {
  const dismissed =
    dismissBulkTask(req.params.id) || dismissLegacyBulkTask(req.params.id);
  if (dismissed) dropExtractResults(req.params.id);
  res.json({ dismissed });
});

/**
 * GET /:id/extract -- the lines an extraction task has collected so far.
 *
 * They are fetched rather than carried on the task itself: a long history across a dozen
 * accounts would be megabytes on a list the panel polls every second or two. `format=text`
 * hands back the rendered lines as a file to download.
 */
router.get("/:id/extract", bulkMgmtGuard, (req, res) => {
  const run = getExtractResults(req.params.id);
  if (!run) {
    res.status(404).json({ error: "No extraction results for that task" });
    return;
  }
  if (req.query.format === "text") {
    const text = run.lines.map((l) => l.line).join("\n");
    res.type("text/plain; charset=utf-8");
    res.send(text ? `${text}\n` : "");
    return;
  }
  res.json({
    lines: run.lines,
    total: run.lines.length,
    truncated: run.truncated,
    placeholders: EXTRACT_PLACEHOLDERS,
  });
});

router.post("/spam-check", (req, res) => {
  const { ids, gapSeconds } = req.body as { ids?: number[]; gapSeconds?: number };
  respond(res, startBulkSpamCheck(numberList(ids), optionalSeconds(gapSeconds)));
});

router.post("/fetch-attributes", (req, res) => {
  const { ids, gapSeconds } = req.body as { ids?: number[]; gapSeconds?: number };
  respond(
    res,
    startBulkFetchAttributes(numberList(ids), optionalSeconds(gapSeconds)),
  );
});

router.post("/login-email", bulkMgmtGuard, (req, res) => {
  const { ids, source, gmail, appPassword, tag, poolType, gapSeconds } =
    req.body as {
      ids?: number[];
      source?: "gmail" | "msapi";
      gmail?: string;
      appPassword?: string;
      tag?: string;
      poolType?: string;
      gapSeconds?: number;
    };
  if (source === "msapi") {
    if (!msApiConfigured()) {
      res.status(400).json({ error: msApiOffReason() });
      return;
    }
  } else if (!gmail || !gmail.includes("@") || !appPassword) {
    res.status(400).json({ error: "gmail and appPassword are required" });
    return;
  }
  respond(
    res,
    startBulkLoginEmail(
      numberList(ids),
      source === "msapi"
        ? { source: "msapi", poolType: (poolType ?? "").trim() }
        : {
            source: "gmail",
            gmail: gmail!.trim(),
            appPassword,
            tag: (tag ?? "").trim(),
          },
      optionalSeconds(gapSeconds),
    ),
  );
});

router.post("/credentials", bulkMgmtGuard, (req, res) => {
  const {
    ids,
    currentPassword,
    newPassword,
    removeDevices,
    removePasskeys,
    notesAppend,
    gapSeconds,
  } = req.body as {
    ids?: number[];
    currentPassword?: string;
    newPassword?: string;
    removeDevices?: boolean;
    removePasskeys?: boolean;
    notesAppend?: string;
    gapSeconds?: number;
  };
  if (!newPassword) {
    res.status(400).json({ error: "newPassword is required" });
    return;
  }
  respond(
    res,
    startBulkCredentials(
      numberList(ids),
      {
        currentPassword,
        newPassword,
        removeDevices: Boolean(removeDevices),
        removePasskeys: Boolean(removePasskeys),
        notesAppend,
      },
      optionalSeconds(gapSeconds),
    ),
  );
});

router.post("/passkey", bulkMgmtGuard, (req, res) => {
  const { ids, gapSeconds } = req.body as { ids?: number[]; gapSeconds?: number };
  respond(res, startBulkPasskey(numberList(ids), optionalSeconds(gapSeconds)));
});

// POST /privacy -- write the chosen level (nobody / contacts / everybody) for each privacy key.
// An omitted or unknown key is left untouched; no body at all means the old lockdown default.
router.post("/privacy", bulkMgmtGuard, (req, res) => {
  const { ids, settings, gapSeconds } = req.body as {
    ids?: number[];
    settings?: Record<string, string>;
    gapSeconds?: number;
  };
  let selection: PrivacySelection;
  if (settings && typeof settings === "object") {
    selection = {};
    for (const key of PRIVACY_KEYS) {
      const level = settings[key];
      if (isPrivacyLevel(level)) selection[key] = level;
    }
    if (!Object.keys(selection).length) {
      res.status(400).json({ error: "no known privacy settings given" });
      return;
    }
  } else {
    selection = allNarrowest();
  }
  respond(res, startBulkPrivacy(numberList(ids), selection, optionalSeconds(gapSeconds)));
});

router.post("/clean", bulkMgmtGuard, (req, res) => {
  const { ids, gapSeconds } = req.body as { ids?: number[]; gapSeconds?: number };
  respond(res, startBulkClean(numberList(ids), optionalSeconds(gapSeconds)));
});

/**
 * POST /extract-messages -- read one chat's history on each selected account.
 *
 * Behind the bulk-management guard with the rest of the multi-account actions. Writing what
 * it finds into the data store is separately refused by the starter when that feature is off.
 */
router.post("/extract-messages", bulkMgmtGuard, (req, res) => {
  const { ids, gapSeconds, ...input } = req.body as BulkExtractInput & {
    ids?: number[];
    gapSeconds?: number;
  };
  respond(
    res,
    startBulkExtractMessages(numberList(ids), input, optionalSeconds(gapSeconds)),
  );
});

// POST /run-jobs -- trigger the selected jobs one after another
router.post("/run-jobs", (req, res) => {
  const { ids, gapSeconds, maxRunSeconds } = req.body as {
    ids?: number[];
    gapSeconds?: number;
    maxRunSeconds?: number;
  };
  respond(
    res,
    startBulkJobRuns(
      numberList(ids),
      optionalSeconds(gapSeconds),
      optionalSeconds(maxRunSeconds),
    ),
  );
});

export default router;
