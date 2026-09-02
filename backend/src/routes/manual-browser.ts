import { Router } from "express";
import { db } from "../db/database";
import {
  currentManualSession,
  gotoManualSession,
  issueManualTicket,
  jobById,
  startManualSession,
  stopManualSession,
  touchManualSession,
  typeIntoManualSession,
  watchRun,
} from "../jobs/manualBrowser";
import { resolveWebProxyUrl } from "../jobs/runner";
import { liveRunDisplays } from "../jobs/runDisplays";

/**
 * Opening a job's browser to drive by hand: the way a login a site rations, or a challenge
 * the solver could not get through, gets done once so the scheduled runs have the cookie.
 *
 * Everything here is behind the panel's own auth, like the rest of the API. The screen itself
 * travels over /ws/vnc, which takes a single-use ticket issued below.
 */
const router = Router();

router.get("/", (req, res) => {
  const session = currentManualSession();
  // The viewer polls this while it is open: reading a page is not being idle, and the idle
  // timer would otherwise close a session someone is still looking at. `watching=0` says the
  // caller only wants the list -- the jobs list keeps it up to date in the background, and a
  // poll nobody is watching must not hold a hand-driven session open.
  if (session && req.query.watching !== "0") touchManualSession(session.id);
  // Runs with a screen up, so the panel can offer to watch one
  res.json({ session: session ?? null, runs: liveRunDisplays() });
});

/** Attaches to a job that is already running, rather than opening a browser. */
router.post("/watch", async (req, res) => {
  const runId = String((req.body as { runId?: string }).runId ?? "");
  if (!runId) return res.status(400).json({ error: "runId is required" });
  try {
    const session = await watchRun(runId);
    res.json({ session, ticket: issueManualTicket(session.id) });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

router.post("/start", async (req, res) => {
  const jobId = Number((req.body as { jobId?: number }).jobId ?? 0);
  const url = (req.body as { url?: string }).url;
  if (!jobId) return res.status(400).json({ error: "jobId is required" });

  const job = jobById(jobId);
  if (!job) return res.status(404).json({ error: "No such job" });

  try {
    const account = job.accountId
      ? (db
          .prepare("SELECT id, proxy_id as proxyId FROM tg_accounts WHERE id = ?")
          .get(job.accountId) as { id: number; proxyId: string | null } | undefined)
      : undefined;
    // The same exit the job uses: a session from another IP leaves a cookie the site may
    // well refuse to honour when the job comes back on its own address
    const proxyUrl = resolveWebProxyUrl(account?.proxyId ?? null, job);
    const session = await startManualSession({
      job,
      proxyUrl,
      accountId: account?.id,
      url,
    });
    res.json({ session, ticket: issueManualTicket(session.id) });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

/** A fresh ticket for the same session, for a viewer that reconnected. */
router.post("/ticket", (_req, res) => {
  const session = currentManualSession();
  if (!session) return res.status(404).json({ error: "No browser is open" });
  res.json({ session, ticket: issueManualTicket(session.id) });
});

/** Sends the open browser to an address. */
router.post("/goto", async (req, res) => {
  const url = String((req.body as { url?: string }).url ?? "");
  try {
    res.json({ url: await gotoManualSession(url) });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

/**
 * Types text into the focused field through the browser itself.
 *
 * The VNC keyboard cannot carry anything the remote keymap lacks, which is every CJK
 * character, so this is what the panel uses for those.
 */
router.post("/type", async (req, res) => {
  const text = String((req.body as { text?: string }).text ?? "");
  try {
    await typeIntoManualSession(text);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

router.post("/stop", async (_req, res) => {
  await stopManualSession();
  res.json({ ok: true });
});

export default router;
