import { Router, raw } from "express";
import { assertPublicUrl, isFrameable } from "../tg/safeFetch";
import {
  issueWebviewTicket,
  webviewClaimUrl,
  webviewProxyUrl,
  webviewPublicOrigin,
  type WebviewMode,
} from "../tg/webviewTickets";
import {
  getLiveClient,
  loadDialogs,
  getMessages,
  sendMessage,
  type TgNameMention,
  sendFile,
  sharePhoneNumber,
  normalisePhoneNumber,
  getContacts,
  addContact,
  editContact,
  searchPeers,
  fetchPhoto,
  getEntityDetails,
  muteDialog,
  pinDialog,
  clickButton,
  sendReaction,
  getThreadMessages,
  getBotInfo,
  markRead,
  resolvePeer,
  reconnectClient,
  getFolders,
  addChatToFolder,
  checkInvite,
  joinInvite,
  isAuthError,
  markSessionExpired,
  getCachedMessages,
  cacheMessages,
  clearCachedMessages,
  removeCachedMessages,
  updateCachedMessageText,
  setBlocked,
  reportPeer,
  deleteHistory,
  deleteMessages,
  editMessage,
  forwardMessages,
  sendTyping,
  syncMessagesInBackground,
  joinChannel,
  leaveChat,
  getCachedDialogs,
  cacheDialogs,
  removeCachedDialog,
  clearAccountCache,
  cleanAccount,
  syncDialogsInBackground,
  fetchAvatarsBatch,
  checkMembership,
  resolveWebApp,
  startBot,
  getPinnedMessage,
  getReadOutboxMaxId,
  getChatMembers,
} from "../tg/liveClient";
import type { Response } from "express";
import { issueMediaTicket } from "../auth/mediaTickets";
import { requireMediaAuth } from "../middleware/auth";

// Centralised error response: marks session expired for auth errors automatically.
function tgError(err: any, accountId: number, res: Response): void {
  if (isAuthError(err?.message ?? "")) markSessionExpired(accountId);
  res.status(500).json({ error: err?.message ?? "Unknown error" });
}

const router = Router();

/**
 * Routes a browser loads by address rather than by fetch, so they authenticate with a media
 * ticket instead of a header. Mounted in server.ts ahead of the session guard; anything it
 * does not match falls through to the guarded router.
 */
export const mediaRouter = Router();

// GET /frameable?url= -- probe whether a page allows cross-origin framing
router.get("/frameable", async (req, res) => {
  const url = req.query.url as string;
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "valid url required" });
    return;
  }
  try {
    await assertPublicUrl(url);
  } catch {
    res.status(400).json({ error: "URL not allowed" });
    return;
  }
  res.json({ frameable: await isFrameable(url) });
});

// POST /webview/ticket -- an address for the viewer to show a page that refuses framing.
// Requested here, where the caller is authenticated, so the address handed to the iframe
// carries only the ticket: the page can read its own URL, and a session token there would be
// a session token given to the site. See tg/webviewTickets.
router.post("/webview/ticket", (req, res) => {
  const { url, mode } = req.body as { url?: string; mode?: WebviewMode };
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "valid url required" });
    return;
  }
  try {
    const ticket = issueWebviewTicket(url, mode === "app" ? "app" : "page");
    // A viewer origin serves the page at its own root, which a Mini App needs to route itself,
    // and being a separate origin the frame may hold it with `allow-same-origin`. Without one
    // configured the page still loads under a path prefix here, which suits a plain web page.
    const viewerOrigin = webviewPublicOrigin();
    res.json({
      proxyUrl: viewerOrigin
        ? webviewClaimUrl(ticket.id, url, viewerOrigin)
        : webviewProxyUrl(ticket.id, url),
      isolated: Boolean(viewerOrigin),
      expiresAt: ticket.expiresAt,
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "url not allowed" });
  }
});

// POST /media-ticket -- a short-lived credential for addresses the browser loads itself.
// An <img src> cannot set an Authorization header, and the session token has no business
// being in a URL (see auth/mediaTickets).
router.post("/media-ticket", (_req, res) => {
  res.json(issueMediaTicket());
});

// GET /:accountId/folders
router.get("/:accountId/folders", async (req, res) => {
  const accountId = Number(req.params.accountId);
  try {
    const entry = await getLiveClient(accountId);
    res.json(await getFolders(entry));
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/folders/:folderId/chats -- add a chat to a folder
router.post("/:accountId/folders/:folderId/chats", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const folderId = Number(req.params.folderId);
  const { chatId } = req.body as { chatId?: string };
  if (!chatId) {
    res.status(400).json({ error: "chatId is required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    await addChatToFolder(entry, folderId, chatId);
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/dialogs?limit=
router.get("/:accountId/dialogs", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const limit = Math.min(Number(req.query.limit ?? 200), 200);
  try {
    const entry = await getLiveClient(accountId);
    const cached = getCachedDialogs(accountId);
    if (cached.length > 0) {
      res.json(cached);
      // Refresh in background and push updates via WebSocket
      syncDialogsInBackground(accountId).catch(() => {});
      return;
    }
    const dialogs = await loadDialogs(entry, limit);
    cacheDialogs(accountId, dialogs);
    res.json(dialogs);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/messages/:chatId?limit=50&offsetId=0&fresh=1
router.get("/:accountId/messages/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = req.params.chatId;
  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const offsetId = Number(req.query.offsetId ?? 0);
  const fresh = req.query.fresh === "1"; // bypass cache when true
  try {
    const entry = await getLiveClient(accountId);

    // Apply current readOutboxMaxId so cached blobs always reflect latest read state
    const applyReadStatus = <T extends { fromMe: boolean; id: number; isRead: boolean }>(
      msgs: T[],
    ): T[] => {
      const readMaxId = getReadOutboxMaxId(accountId, chatId);
      if (!readMaxId) return msgs;
      return msgs.map((m) => m.fromMe ? { ...m, isRead: m.id <= readMaxId } : m);
    };

    if (offsetId === 0 && !fresh) {
      // Initial load: serve from cache instantly, sync new messages in the background
      const cached = getCachedMessages(accountId, chatId, limit);
      if (cached.length > 0) {
        res.json(applyReadStatus(cached));
        syncMessagesInBackground(accountId, chatId).catch(() => {});
        return;
      }
    } else if (offsetId !== 0) {
      // Pagination: serve from cache if it covers a full page
      const cached = getCachedMessages(accountId, chatId, limit, offsetId);
      if (cached.length >= limit) {
        res.json(applyReadStatus(cached));
        return;
      }
    }

    const msgs = await getMessages(entry, chatId, limit, offsetId);
    cacheMessages(accountId, chatId, msgs);
    res.json(msgs);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/messages/:chatId/search?q=term&limit=30 -- server-side search
// within one chat (Telegram messages.Search); never served from cache
router.get("/:accountId/messages/:chatId/search", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const q = String(req.query.q ?? "").trim();
  const limit = Math.min(Number(req.query.limit ?? 30), 100);
  if (!q) {
    res.json([]);
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const msgs = await getMessages(entry, chatId, limit, 0, q);
    res.json(msgs);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/chats/:chatId/pinned -- fetch the pinned message for a group/channel
router.get("/:accountId/chats/:chatId/pinned", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    const msg = await getPinnedMessage(entry, chatId);
    res.json(msg ?? null);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// DELETE /:accountId/messages/:chatId/cache -- clear the local message cache for a chat
router.delete("/:accountId/messages/:chatId/cache", (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  clearCachedMessages(accountId, chatId);
  res.json({ ok: true });
});

/**
 * Mentions of members without a username, as {offset, length, chatId} spans over the
 * message text. Anything malformed is dropped rather than rejected -- the worst case is
 * the name staying plain text.
 */
function parseNameMentions(raw: unknown): TgNameMention[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const mentions = raw.flatMap((m: any) => {
    const offset = Number(m?.offset);
    const length = Number(m?.length);
    const chatId = String(m?.chatId ?? "");
    if (!Number.isInteger(offset) || offset < 0) return [];
    if (!Number.isInteger(length) || length <= 0) return [];
    if (!/^u\d+$/.test(chatId)) return [];
    return [{ offset, length, chatId }];
  });
  return mentions.length ? mentions : undefined;
}

// POST /:accountId/messages/:chatId -- send a message
router.post("/:accountId/messages/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = req.params.chatId;
  const { text, replyToMsgId, mentions } = req.body as {
    text?: string;
    replyToMsgId?: number;
    mentions?: unknown;
  };
  if (!text?.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const result = await sendMessage(
      entry,
      chatId,
      text.trim(),
      replyToMsgId ? Number(replyToMsgId) : undefined,
      parseNameMentions(mentions),
    );
    // Cache immediately -- GramJS won't fire NewMessage for UpdateShortSentMessage responses
    cacheMessages(accountId, chatId, [
      {
        id: result.id,
        text: text.trim(),
        html: null,
        date: result.date,
        fromMe: true,
        isRead: false,
        fromId: null,
        fromName: null,
        hasPhoto: false,
        hasDocument: false,
        hasSticker: false,
        fileName: null,
        buttons: null,
        reactions: null,
        replyToId: replyToMsgId ? Number(replyToMsgId) : null,
        replyToText: null,
        replyToName: null,
        replyCount: null,
      },
    ]);
    res.json(result);
    // Poll for bot replies at 1.5 s, 4 s, and 9 s after sending.
    // GramJS NewMessage fires for incoming messages; this is the fallback for any it misses.
    for (const delay of [1500, 4000, 9000]) {
      setTimeout(() => {
        syncMessagesInBackground(accountId, chatId).catch(() => {});
      }, delay);
    }
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/messages/:chatId/share-phone -- answer a bot's "share phone number"
// reply-keyboard button by sending our own number as a contact card.
router.post("/:accountId/messages/:chatId/share-phone", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const { replyToMsgId, phoneNumber } = req.body as {
    replyToMsgId?: number;
    phoneNumber?: string;
  };
  if (phoneNumber && !normalisePhoneNumber(phoneNumber)) {
    res.status(400).json({ error: "Not a valid phone number" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const result = await sharePhoneNumber(
      entry,
      chatId,
      replyToMsgId ? Number(replyToMsgId) : undefined,
      phoneNumber?.trim() || undefined,
    );
    cacheMessages(accountId, chatId, [
      {
        id: result.id,
        text: result.text,
        html: null,
        date: result.date,
        fromMe: true,
        isRead: false,
        fromId: null,
        fromName: null,
        hasPhoto: false,
        hasDocument: false,
        hasSticker: false,
        fileName: null,
        buttons: null,
        reactions: null,
        replyToId: replyToMsgId ? Number(replyToMsgId) : null,
        replyToText: null,
        replyToName: null,
        replyCount: null,
      },
    ]);
    res.json(result);
    // Same reply-polling fallback as a plain send: the bot usually answers straight away.
    for (const delay of [1500, 4000, 9000]) {
      setTimeout(() => {
        syncMessagesInBackground(accountId, chatId).catch(() => {});
      }, delay);
    }
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/messages/:chatId/file -- send a photo or document.
// Body is the raw file bytes (application/octet-stream); metadata is passed as
// query params so we skip base64/multipart overhead.
// The body is held in memory for the whole upload, so on a small host this bound is
// real memory per concurrent send -- lower it with TG_UPLOAD_MAX_MB.
const UPLOAD_LIMIT = `${Number(process.env.TG_UPLOAD_MAX_MB ?? 50)}mb`;
router.post(
  "/:accountId/messages/:chatId/file",
  raw({ type: () => true, limit: UPLOAD_LIMIT }),
  async (req, res) => {
    const accountId = Number(req.params.accountId);
    const chatId = req.params.chatId;
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const filename = String(req.query.filename || "file");
    const caption = req.query.caption ? String(req.query.caption) : undefined;
    const forceDocument = req.query.asDocument === "1";
    const replyToMsgId = req.query.replyToMsgId
      ? Number(req.query.replyToMsgId)
      : undefined;
    try {
      const entry = await getLiveClient(accountId);
      const result = await sendFile(entry, chatId, {
        buffer: buf,
        filename,
        caption,
        forceDocument,
        replyToMsgId,
      });
      cacheMessages(accountId, chatId, [
        {
          id: result.id,
          text: caption ?? "",
          html: null,
          date: result.date,
          fromMe: true,
          isRead: false,
          fromId: null,
          fromName: null,
          hasPhoto: result.hasPhoto,
          hasDocument: result.hasDocument,
          hasSticker: false,
          fileName: result.hasDocument ? filename : null,
          buttons: null,
          reactions: null,
          replyToId: replyToMsgId ?? null,
          replyToText: null,
          replyToName: null,
          replyCount: null,
        },
      ]);
      res.json(result);
      for (const delay of [1500, 4000, 9000]) {
        setTimeout(() => {
          syncMessagesInBackground(accountId, chatId).catch(() => {});
        }, delay);
      }
    } catch (err: any) {
      tgError(err, accountId, res);
    }
  },
);

// GET /:accountId/contacts
router.get("/:accountId/contacts", async (req, res) => {
  const accountId = Number(req.params.accountId);
  try {
    const entry = await getLiveClient(accountId);
    const contacts = await getContacts(entry);
    res.json(contacts);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/contacts -- add by phone number
router.post("/:accountId/contacts", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const { phone, firstName, lastName } = req.body as {
    phone?: string;
    firstName?: string;
    lastName?: string;
  };
  if (!phone || !firstName) {
    res.status(400).json({ error: "phone and firstName are required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const contact = await addContact(entry, phone, firstName, lastName ?? "");
    if (!contact) {
      res.status(404).json({ error: "Phone number not found on Telegram" });
      return;
    }
    res.json(contact);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// PUT /:accountId/contacts/:userId -- update first/last name of an existing contact
router.put("/:accountId/contacts/:userId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const userId = decodeURIComponent(req.params.userId);
  const { firstName, lastName } = req.body as {
    firstName?: string;
    lastName?: string;
  };
  if (!firstName) {
    res.status(400).json({ error: "firstName is required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const contact = await editContact(entry, userId, firstName, lastName ?? "");
    if (!contact) {
      res.status(404).json({ error: "User not found or not a contact" });
      return;
    }
    res.json(contact);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/search?q=
router.get("/:accountId/search", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.json([]);
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const results = await searchPeers(entry, q);
    res.json(results);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/mute/:chatId -- mute (muteSecs>0) or unmute (muteSecs=0)
router.post("/:accountId/mute/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const { muteSecs = 0 } = req.body as { muteSecs?: number };
  try {
    const entry = await getLiveClient(accountId);
    await muteDialog(entry, chatId, Number(muteSecs));
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/pin/:chatId -- pin or unpin
router.post("/:accountId/pin/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const { pinned = true } = req.body as { pinned?: boolean };
  try {
    const entry = await getLiveClient(accountId);
    await pinDialog(entry, chatId, Boolean(pinned));
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/typing/:chatId -- broadcast a typing notification
router.post("/:accountId/typing/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    await sendTyping(entry, chatId);
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/block/:chatId -- block or unblock a user
router.post("/:accountId/block/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const { blocked = true } = req.body as { blocked?: boolean };
  try {
    const entry = await getLiveClient(accountId);
    await setBlocked(entry, chatId, Boolean(blocked));
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/report/:chatId -- report a user, group or channel
router.post("/:accountId/report/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const { reason, comment = "" } = req.body as {
    reason?: string;
    comment?: string;
  };
  if (!reason) {
    res.status(400).json({ error: "reason is required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    await reportPeer(entry, chatId, reason as any, String(comment));
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// DELETE /:accountId/cache -- drop all cached data for the account.
// Works without a connected client; everything refetches on demand.
router.delete("/:accountId/cache", (req, res) => {
  const accountId = Number(req.params.accountId);
  try {
    clearAccountCache(accountId);
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/clean -- leave all groups/channels and delete all private
// chats for both sides. Irreversible; the frontend confirms before calling.
router.post("/:accountId/clean", async (req, res) => {
  const accountId = Number(req.params.accountId);
  try {
    const entry = await getLiveClient(accountId);
    const result = await cleanAccount(entry, accountId);
    syncDialogsInBackground(accountId).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// DELETE /:accountId/history/:chatId?revoke=1 -- delete chat history
router.delete("/:accountId/history/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const revoke = req.query.revoke === "1";
  try {
    const entry = await getLiveClient(accountId);
    await deleteHistory(entry, chatId, revoke);
    clearCachedMessages(accountId, chatId);
    // Drop the cached dialog row immediately, otherwise the chat
    // reappears from the cache on the next dialog load
    removeCachedDialog(accountId, chatId);
    // Refresh the dialog list so the removed chat disappears
    syncDialogsInBackground(accountId).catch(() => {});
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/messages/:chatId/delete -- delete messages { ids, revoke }
router.post("/:accountId/messages/:chatId/delete", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const { ids, revoke = true } = req.body as {
    ids?: number[];
    revoke?: boolean;
  };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: "ids is required" });
    return;
  }
  const msgIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  try {
    const entry = await getLiveClient(accountId);
    await deleteMessages(entry, chatId, msgIds, Boolean(revoke));
    removeCachedMessages(accountId, chatId, msgIds);
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/messages/:chatId/:msgId/edit -- edit an own message { text }
router.post("/:accountId/messages/:chatId/:msgId/edit", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const msgId = Number(req.params.msgId);
  const { text, mentions } = req.body as { text?: string; mentions?: unknown };
  if (!text?.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    await editMessage(
      entry,
      chatId,
      msgId,
      text.trim(),
      parseNameMentions(mentions),
    );
    updateCachedMessageText(accountId, chatId, msgId, text.trim());
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/messages/:chatId/forward -- forward messages { toChatId, ids }
router.post("/:accountId/messages/:chatId/forward", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const { toChatId, ids } = req.body as { toChatId?: string; ids?: number[] };
  if (!toChatId || !Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: "toChatId and ids are required" });
    return;
  }
  const msgIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  try {
    const entry = await getLiveClient(accountId);
    await forwardMessages(entry, chatId, String(toChatId), msgIds);
    // Sync the target chat so the forwarded messages appear promptly
    syncMessagesInBackground(accountId, String(toChatId)).catch(() => {});
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/avatars?ids=chatId1,chatId2,... -- batch profile photos
// Returns { [chatId]: base64String } for chats that have an avatar.
router.get("/:accountId/avatars", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const idsParam = (req.query.ids as string) ?? "";
  const chatIds = idsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 300);
  try {
    const entry = await getLiveClient(accountId);
    const result = await fetchAvatarsBatch(entry, chatIds);
    res.set("Cache-Control", "public, max-age=3600");
    res.json(result);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/profile/:chatId -- full entity details
router.get("/:accountId/profile/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    res.json(await getEntityDetails(entry, chatId));
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/messages/:chatId/:msgId/button -- trigger inline keyboard callback
router.post("/:accountId/messages/:chatId/:msgId/button", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const msgId = Number(req.params.msgId);
  const { data } = req.body as { data?: string };
  if (!data) {
    res.status(400).json({ error: "data is required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const result = await clickButton(entry, chatId, msgId, data);
    res.json(result);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/messages/:chatId/:msgId/reaction -- send or remove a reaction
router.post(
  "/:accountId/messages/:chatId/:msgId/reaction",
  async (req, res) => {
    const accountId = Number(req.params.accountId);
    const chatId = decodeURIComponent(req.params.chatId);
    const msgId = Number(req.params.msgId);
    const { emoji } = req.body as { emoji?: string | null };
    try {
      const entry = await getLiveClient(accountId);
      await sendReaction(entry, chatId, msgId, emoji ?? null);
      res.json({ ok: true });
    } catch (err: any) {
      tgError(err, accountId, res);
    }
  },
);

// GET /:accountId/messages/:chatId/:msgId/thread -- replies / comments for a message
router.get("/:accountId/messages/:chatId/:msgId/thread", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const msgId = Number(req.params.msgId);
  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const offsetId = Number(req.query.offsetId ?? 0);
  try {
    const entry = await getLiveClient(accountId);
    const msgs = await getThreadMessages(entry, chatId, msgId, limit, offsetId);
    res.json(msgs);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/messages/:chatId/:msgId/photo -- fetch photo for a message.
//
// On `mediaRouter`, not the router below, because the difference is where the guard sits.
// The main router is mounted behind `requireAuth`, which only reads the Authorization
// header; an <img> cannot set one, so a request carrying a perfectly good media ticket was
// refused by the outer guard before this route was ever consulted. This router is mounted
// ahead of that guard and carries its own.
mediaRouter.get("/:accountId/messages/:chatId/:msgId/photo", requireMediaAuth, async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = req.params.chatId;
  const msgId = Number(req.params.msgId);
  try {
    const entry = await getLiveClient(accountId);
    const result = await fetchPhoto(entry, chatId, msgId);
    if (!result) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    res.set("Content-Type", result.mimeType);
    res.set("Cache-Control", "private, max-age=3600");
    res.send(result.buf);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/reconnect -- disconnect and reconnect a live client
router.post("/:accountId/reconnect", async (req, res) => {
  const accountId = Number(req.params.accountId);
  try {
    await reconnectClient(accountId);
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/invite/:hash -- preview a t.me/+ invite link
router.get("/:accountId/invite/:hash", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const hash = req.params.hash;
  try {
    const entry = await getLiveClient(accountId);
    const preview = await checkInvite(entry, hash);
    res.json(preview);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/invite/:hash -- join via invite link
router.post("/:accountId/invite/:hash", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const hash = req.params.hash;
  try {
    const entry = await getLiveClient(accountId);
    const dialog = await joinInvite(entry, hash);
    res.json(dialog);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/resolve-peer -- resolve a t.me username to a dialog object
router.post("/:accountId/resolve-peer", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const { username } = req.body as { username?: string };
  if (!username) {
    res.status(400).json({ error: "username is required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const dialog = await resolvePeer(entry, username);
    if (!dialog) {
      res.status(404).json({ error: "Peer not found" });
      return;
    }
    res.json(dialog);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/mark-read/:chatId -- mark messages as read up to maxId
router.post("/:accountId/mark-read/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const { maxId } = req.body as { maxId?: number };
  if (!maxId) {
    res.status(400).json({ error: "maxId is required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    await markRead(entry, chatId, Number(maxId));
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/bot-commands/:chatId -- commands for a bot chat
// GET /:accountId/bot-info/:chatId -- the bot's command list and its menu button (the
// Mini App pinned beside the composer). One call: both are read off the same GetFullUser.
router.get("/:accountId/bot-info/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    res.json(await getBotInfo(entry, chatId));
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// True when the response headers allow embedding the page in an iframe from another origin
// POST /:accountId/webview/resolve -- resolve a mini app URL to an authenticated web app URL
router.post("/:accountId/webview/resolve", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const { url, botChatId, peerChatId, fromBotMenu } = req.body as {
    url: string;
    botChatId?: string;
    peerChatId?: string;
    fromBotMenu?: boolean;
  };
  if (!url) {
    res.status(400).json({ error: "url required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const { url: webAppUrl, resolved } = await resolveWebApp(
      entry,
      url,
      botChatId,
      peerChatId,
      fromBotMenu,
    );
    // Telegram answering at all is not the same as Telegram signing the address: a request
    // made the wrong way comes back with a URL and no account data in it, and the only sign
    // of that used to be the app itself failing on "No initData found" once it had loaded.
    const signed = /[#&]tgWebAppData=/.test(webAppUrl);
    if (resolved && !signed) {
      console.warn(
        `[tg-client] webview resolve returned no account data for ${new URL(webAppUrl).host}` +
          `${fromBotMenu ? " (menu button)" : ""} -- the app will load logged out`,
      );
    }
    // Probed even when Telegram signed the URL. A signed URL is not a frameable one: apps
    // increasingly send `frame-ancestors 'self' https://web.telegram.org` (or X-Frame-Options
    // SAMEORIGIN), which keeps working in Telegram's own clients while our origin is refused.
    // Assuming otherwise showed the operator a dead panel reading "refused to connect".
    const frameable = await isFrameable(webAppUrl);
    res.json({ webAppUrl, resolved, frameable, signed });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/members/:chatId?limit=&offset=&query= -- group participants
router.get("/:accountId/members/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 200), 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const query = ((req.query.query as string) ?? "").trim();
  try {
    const entry = await getLiveClient(accountId);
    res.json(await getChatMembers(entry, chatId, limit, offset, query));
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/membership/:chatId -- check if user is currently a member
router.get("/:accountId/membership/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    const isMember = await checkMembership(entry, chatId);
    res.json({ member: isMember });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/join/:chatId -- join a public channel or supergroup
router.post("/:accountId/join/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    const result = await joinChannel(entry, chatId);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

router.post("/:accountId/leave/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    await leaveChat(entry, chatId);
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/start-bot/:username -- open bot and send startParam (t.me/bot?start=PARAM)
router.post("/:accountId/start-bot/:username", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const username = req.params.username;
  const { startParam } = req.body as { startParam: string };
  try {
    const entry = await getLiveClient(accountId);
    const dialog = await startBot(entry, username, startParam);
    res.json(dialog);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

export default router;
