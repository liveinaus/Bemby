import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { verifySessionToken } from "../middleware/auth";
import {
  getLiveClient,
  subscribeToMessages,
  subscribeToDialogs,
  subscribeToReadOutbox,
  subscribeToTyping,
  subscribeToEvents,
  reconcileChat,
} from "./liveClient";

// A watchdog, not the delivery mechanism. Edits, deletions and reactions now arrive as
// updates, and a gap is replayed by the catch-up on connect, so this only has to cover the
// case where the socket is up but Telegram has quietly stopped sending. The old four-second
// poll refetched a hundred messages a tick and still could not see an edit.
const RECONCILE_INTERVAL_MS = 30_000;

/**
 * The panel's own socket. Built with `noServer` and handed to the router in server.ts:
 * a WebSocketServer bound straight to the HTTP server answers *every* upgrade, and
 * destroys the ones whose path it does not recognise -- which is how a second socket on
 * the same server ends up dead before its own handler ever runs.
 */
export function createPanelWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const accountId = Number(url.searchParams.get("accountId") ?? "0");

    if (!accountId) {
      ws.close(1008, "Missing accountId");
      return;
    }

    // Authenticate via the first message (not the URL) so tokens never appear in access logs
    const authTimeout = setTimeout(() => {
      ws.close(1008, "Auth timeout");
    }, 5_000);

    ws.once("message", async (rawData: Buffer) => {
      clearTimeout(authTimeout);
      let msg: { type: string; token?: string };
      try {
        msg = JSON.parse(rawData.toString()) as { type: string; token?: string };
      } catch {
        ws.close(1008, "Invalid auth message");
        return;
      }

      if (msg.type !== "auth" || !msg.token) {
        ws.close(1008, "Expected auth message");
        return;
      }

      // Same validation as the HTTP guard: reject captcha/non-session tokens,
      // and block access while a default-password change is still pending
      const decoded = verifySessionToken(msg.token);
      if (!decoded || decoded.requirePasswordChange) {
        ws.close(1008, "Unauthorised");
        return;
      }

      ws.send(JSON.stringify({ type: "authenticated" }));
      await setupConnection(ws, accountId);
    });
  });

  return wss;
}

async function setupConnection(ws: WebSocket, accountId: number): Promise<void> {
    try {
      await getLiveClient(accountId);
    } catch (err: any) {
      ws.send(JSON.stringify({ type: "error", error: "Failed to connect to Telegram" }));
      ws.close();
      return;
    }

    const unsubscribeMsgs = subscribeToMessages(accountId, (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "message", ...msg }));
      }
    });

    const unsubscribeDialogs = subscribeToDialogs(accountId, (dialogs) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dialogs", dialogs }));
      }
    });

    const unsubscribeReadOutbox = subscribeToReadOutbox(accountId, (chatId, maxId) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "readOutbox", chatId, maxId }));
      }
    });

    const unsubscribeTyping = subscribeToTyping(accountId, (event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing", ...event }));
      }
    });

    // Edits, deletions, reactions, incoming read marks, pins and connection state. Each
    // event already carries its own `type`, so it goes out as-is; a client that predates
    // one of them ignores the frame rather than breaking on it.
    const unsubscribeEvents = subscribeToEvents(accountId, (event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });

    // Track which chat the frontend currently has open
    let activeChatId: string | null = null;

    const syncInterval = setInterval(() => {
      if (activeChatId && ws.readyState === WebSocket.OPEN) {
        reconcileChat(accountId, activeChatId).catch(() => {});
      }
    }, RECONCILE_INTERVAL_MS);

    ws.on("message", (rawData: Buffer) => {
      try {
        const data = JSON.parse(rawData.toString()) as {
          type: string;
          chatId?: string;
        };
        if (data.type === "activateChat" && typeof data.chatId === "string") {
          activeChatId = data.chatId;
          // Opening a chat is the moment its staleness shows, so check it there and then
          // rather than waiting up to a full watchdog interval.
          reconcileChat(accountId, data.chatId, { force: true }).catch(() => {});
        }
      } catch {
        /* ignore malformed messages */
      }
    });

    // Native ping/pong keepalive -- terminate if the client stops responding
    let isAlive = true;
    const pingInterval = setInterval(() => {
      if (!isAlive) {
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
    }, 25_000);

    ws.on("pong", () => {
      isAlive = true;
    });

    const cleanup = () => {
      clearInterval(pingInterval);
      clearInterval(syncInterval);
      unsubscribeMsgs();
      unsubscribeDialogs();
      unsubscribeReadOutbox();
      unsubscribeTyping();
      unsubscribeEvents();
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);
}
