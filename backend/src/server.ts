import "dotenv/config";
import express from "express";
import { createServer } from "http";

// GramJS throws TIMEOUT from its background _updateLoop after disconnect — suppress it
process.on("unhandledRejection", (reason: any) => {
  if (reason?.message === "TIMEOUT") return;
  console.error("Unhandled rejection:", reason);
});
import cors from "cors";
import path from "path";

import authRouter from "./routes/auth";
import accountsRouter from "./routes/accounts";
import jobsRouter from "./routes/jobs";
import manualBrowserRouter from "./routes/manual-browser";
import logsRouter from "./routes/logs";
import statusRouter from "./routes/status";
import settingsRouter from "./routes/settings";
import secretsRouter from "./routes/secrets";
import dataRouter from "./routes/data";
import dataStoreRouter from "./routes/dataStore";
import debugRouter from "./routes/debug";
import aiSuppliersRouter from "./routes/ai-suppliers";
import templatesRouter from "./routes/templates";
import bulkTasksRouter from "./routes/bulk-tasks";
import tgClientRouter, { mediaRouter as tgClientMediaRouter } from "./routes/tgClient";
import webviewProxyRouter from "./routes/webviewProxy";
import webviewSiteRouter from "./routes/webviewSite";
import { isWebviewHost, webviewPublicOrigin } from "./tg/webviewTickets";
import { requireAuth, getJwtSecret } from "./middleware/auth";
import { startScheduler } from "./scheduler";
import { createPanelWss } from "./tg/wsHandler";
import { createVncWss } from "./tg/vncBridge";
import { startMemoryMonitor, markCleanShutdown } from "./monitor/memory";
import { claimInstanceLock, releaseInstanceLock } from "./instanceLock";

// Validate critical env vars before accepting any requests
getJwtSecret();

// Before the scheduler can launch anything: a second backend on this data dir competes for
// the same licence seats and browser profiles, which kills browsers mid-run
try {
  claimInstanceLock();
} catch (err: any) {
  console.error(`[instance] ${err?.message ?? err}`);
  process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const BIND_HOST = process.env.HOST ?? "0.0.0.0";
const DISPLAY_HOST = process.env.DISPLAY_HOST ?? BIND_HOST;

// TRUST_PROXY: set to the number of proxy hops in front of this app.
// 0/false = direct internet (no proxy) -- clients cannot spoof X-Forwarded-For
// 1       = one reverse proxy (nginx, Caddy, Railway, etc.)
// 2+      = multiple proxies (e.g. Cloudflare + nginx)
const trustProxy = process.env.TRUST_PROXY ?? '0';
app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

// CORS: the SPA is served same-origin in production, so no wildcard is needed.
// CORS_ORIGIN (comma-separated) whitelists extra origins; defaults to the local
// dev frontend. Same-origin requests don't require CORS headers regardless.
const corsOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const allowedOrigins = corsOrigins.length
  ? corsOrigins
  : ["http://localhost:5173", "http://127.0.0.1:5173"];
// A request naming the viewer origin is a framed page asking for itself, not a call on
// Bemby: the whole host belongs to that page, from the root down, which is the only way its
// router works. Mounted first so nothing else claims a path from it.
const viewerOrigin = webviewPublicOrigin();
if (viewerOrigin) {
  console.log(`[webview] serving framed pages on ${viewerOrigin}`);
  app.use((req, res, next) =>
    isWebviewHost(req.headers.host, viewerOrigin) ? webviewSiteRouter(req, res, next) : next(),
  );
}

// The messenger's page viewer, mounted ahead of everything else on purpose. It authenticates
// with its own ticket rather than a session token (see routes/webviewProxy), answers its own
// preflights -- the sandboxed page is an opaque origin, which the CORS whitelist below would
// turn away -- and forwards request bodies untouched, which needs the raw bytes rather than
// the JSON parser's object.
app.use(
  "/api/webview",
  express.raw({ type: "*/*", limit: "10mb" }),
  webviewProxyRouter,
);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "5mb" }));

// Baseline security headers. Kept dependency-free and conservative so the SPA
// and the mini-app iframe keep working; the mini-app proxy strips these itself.
//
// The policy is more than `frame-ancestors` on purpose. The panel renders bot- and
// site-authored content through `v-html` in the logs and the messenger, and the session
// token lives in this origin's localStorage, so one escaping slip would otherwise be worth
// the whole API. `script-src 'self'` means injected markup cannot execute, whatever gets
// past the escaping upstream.
//
// The two loosenings are load-bearing rather than habit:
//   'unsafe-inline' in style-src -- the log and messenger renderers emit inline styles, and
//     Vue's own scoped-style handling sets them too
//   data: and blob: in img-src/media-src -- avatars, message photos and inline media are
//     served to the page as data or object URLs rather than fetched by address
const CSP = [
  "default-src 'self'",
  // Cloudflare injects its Web Analytics beacon into HTML it proxies, so an install sitting
  // behind Cloudflare has a script on the page that the operator never put there. Allowed by
  // name: without it every such install gets a console error on load for something it cannot
  // turn off from here. Remove the origin if you do not front Bemby with Cloudflare.
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  // The panel talks to its own API and its own WebSocket, and nothing else
  "connect-src 'self' ws: wss:",
  // Any http(s) origin, because framing third-party pages is the feature: a Mini App that
  // allows framing is shown at its own address, and only one that refuses is served through
  // the proxy on this origin. Narrowing this to 'self' broke every app of the first kind.
  //
  // This is not the loose end it looks like. A framed document gets its own origin and its
  // own CSP, so nothing here is what keeps it away from the panel; `script-src 'self'`
  // above is, and it is untouched by this.
  "frame-src 'self' https: http:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", CSP);
  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  next();
});

// Health check -- no auth required
app.get("/api/health", (_req: express.Request, res: express.Response) =>
  res.json({ status: "ok" }),
);

// Public routes
app.use("/api/auth", authRouter);

// Protected API routes
app.use("/api/accounts", requireAuth, accountsRouter);
app.use("/api/jobs", requireAuth, jobsRouter);
app.use("/api/manual-browser", requireAuth, manualBrowserRouter);
app.use("/api/logs", requireAuth, logsRouter);
app.use("/api/status", requireAuth, statusRouter);
app.use("/api/settings", requireAuth, settingsRouter);
app.use("/api/secrets", requireAuth, secretsRouter);
// `/api/data` is the backup export/import; the data store is its own router
app.use("/api/data", requireAuth, dataRouter);
app.use("/api/data-store", requireAuth, dataStoreRouter);
app.use("/api/debug", requireAuth, debugRouter);
app.use("/api/ai-suppliers", requireAuth, aiSuppliersRouter);
app.use("/api/templates", requireAuth, templatesRouter);
app.use("/api/bulk-tasks", requireAuth, bulkTasksRouter);
// Inline chat media is loaded straight by the browser, which cannot set an Authorization
// header, so it authenticates with a short-lived media ticket instead. Mounted ahead of
// `requireAuth` because that guard would otherwise refuse the request before the ticket was
// ever looked at; anything this router does not match falls through to the guarded one.
app.use("/api/tg-client", tgClientMediaRouter);
app.use("/api/tg-client", requireAuth, tgClientRouter);

// Serve Vue SPA
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// An /api path no router matched is a missing endpoint, not a page. Without this it falls
// into the SPA fallback below and answers with index.html -- or, in dev where that file is
// not built, with a 500 from the error handler, which reads as a fault in whatever feature
// made the call rather than as a route that is not there.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Unknown API endpoint" });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// Final error handler -- log the detail server-side, never leak stack traces to the client
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[server] Unhandled error:", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  },
);

const server = createServer(app);
// One upgrade listener for every socket. A WebSocketServer bound directly to the HTTP
// server answers all upgrades and destroys those whose path it does not know, so two of
// them on one server kill each other's connections -- routing here is what keeps the
// panel's socket and the manual browser's screen both reachable.
const panelWss = createPanelWss();
const vncWss = createVncWss();
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
  const target = pathname === "/ws" ? panelWss : pathname === "/ws/vnc" ? vncWss : undefined;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});
server.listen(PORT, BIND_HOST, () => {
  console.log(`Bemby admin: http://${DISPLAY_HOST}:${PORT}`);
  // Before the scheduler, so the "previous process died at NNN MB" line prints above the
  // interrupted-runs line it explains
  startMemoryMonitor();
  startScheduler();
});

// An OOM kill is SIGKILL and cannot be trapped, which is the point: a clean stop leaves
// this marker, so its absence on the next boot means the process was killed rather than
// asked to stop.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    markCleanShutdown();
    releaseInstanceLock();
    server.close(() => process.exit(0));
    // Don't wait on lingering keep-alive sockets past the usual container stop grace
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
