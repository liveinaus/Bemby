import { TelegramClient, Api, Logger, utils } from 'telegram';
import { db } from '../db/database';
import { LogLevel } from 'telegram/extensions/Logger';
import { StringSession } from 'telegram/sessions';
import type { TgProxy } from '../types';
import type { TgDeviceParams } from '../auth/tgAuth';
import { NewMessage, NewMessageEvent, Raw } from 'telegram/events';
import { webButtonOf, type WebButton } from '../tg/miniApp';
import { matchesAnyLabel, textSaysFail, textSaysSuccess } from './placeholders';
import { escapeHtml, safeHref } from '../tg/htmlEscape';
import { connectWithTimeout, destroyQuietly, withTgClient } from '../tg/clientTimeout';

export type CheckinAttemptLog = {
  attempt: number;
  commandSent: string;
  hasMedia: boolean;
  commandResponseHtml: string;
  commandResponseImages?: string[];
  availableButtons: string[][];
  buttonClicked?: string;
  callbackAnswer?: string;
  buttonResponseHtml?: string;
  buttonResponseHasMedia?: boolean;
  buttonResponseImage?: string;
  buttonResponseButtons?: string[][];
  /** Set when {aiBtn} was used; records how long the AI took to pick a button */
  aiDurationMs?: number;
  /** The exact prompt text sent to the AI */
  aiPrompt?: string;
  /** The raw response text returned by the AI */
  aiResponse?: string;
  /** Failed AI responses from earlier attempts, when the first attempt(s) didn't match any button */
  aiRetries?: string[];
  error?: string;
  // Dev timing fields
  connectMs?: number;
  replyLatencyMs?: number;
  buttonClickMs?: number;
  buttonResponseMs?: number;
  /** Whether the button response came via a message edit or a new message */
  buttonResponseSource?: 'edit' | 'new_message';
  totalMs?: number;
  replyTimeoutMs?: number;
  errorName?: string;
  /** Host of the Cloudflare-gated checkin URL that was opened (full URL is sensitive). */
  cfHost?: string;
  /** A Cloudflare "I am not a bot" challenge was encountered on that URL. */
  cfChallenged?: boolean;
  /** The challenge was cleared (or the page loaded with none). */
  cfPassed?: boolean;
  /** The page was opened as a Telegram Mini App (WebView button). */
  cfMiniApp?: boolean;
  /** Telegram returned a signed Mini App URL (the app loads logged in). */
  cfMiniAppSigned?: boolean;
  /** Label of the checkin control pressed inside the Mini App page. */
  cfMiniAppAction?: string;
  /** The bot never replied; a standing Mini App button from the chat was opened. */
  cfFromHistory?: boolean;
  /** Proxy whose exit IP the challenge was cleared through. */
  cfProxy?: string;
  /**
   * Which browser build ran this step: "keyed" is the licensed build, "free" the
   * unlicensed fallback used when no licence seat was available. The free build is older
   * and passes fewer challenges, so a run that quietly fell back is worth seeing.
   */
  cfBuild?: "keyed" | "free";
  /** The browser profile the Cloudflare pass ran on, i.e. whose cookies it had. */
  cfProfile?: string;
  /** How many exits were tried before the page loaded. */
  cfAttempts?: number;
};

export class CheckinError extends Error {
  constructor(message: string, public readonly log: CheckinAttemptLog) {
    super(message);
    this.name = 'CheckinError';
  }
}

// Carries partial messages when timeout fires before a buttons-message arrives
class BotReplyTimeoutError extends Error {
  constructor(ms: number, public readonly partial: Api.Message[]) {
    super(`Timed out after ${ms}ms waiting for bot reply`);
    this.name = 'BotReplyTimeoutError';
  }
}

// ── Command template expansion ────────────────────────────────────────────────

// Lives in placeholders.ts so the browser side can expand the same tokens without importing
// a Telegram client; re-exported here, where most callers already reach for it.
import { expandCommand } from './placeholders';
export { expandCommand };

// ── Shared Telegram helpers (also used by custom.ts) ─────────────────────────

export type ParsedMessages = {
  html: string;
  hasMedia: boolean;
  /** All photos in the message group, as base64 data URLs */
  images: string[];
  buttons: string[][];
};

// ── AI button selection ───────────────────────────────────────────────────────

// Strips HTML tags to plain text for the AI prompt
export function htmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getAiSetting(key: string, fallbackEnv: string, defaultVal: string): string {
  const rows = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return rows?.value || process.env[fallbackEnv] || defaultVal;
}

/** Returns true if the value is an aiBtn placeholder (with or without hint) */
export function isAiBtn(val: string): boolean {
  return val === '{aiBtn}' || /^\{aiBtn:.+\}$/.test(val);
}

/** Extracts the hint from {aiBtn:hint}, returns undefined for plain {aiBtn} */
export function parseAiBtnHint(val: string): string | undefined {
  const m = val.match(/^\{aiBtn:(.+)\}$/);
  return m ? m[1].trim() : undefined;
}

type AICreds = { modelId: string; apiKey: string; baseUrl: string; timeoutMs: number };

// The answer itself (captcha chars / button text) is tiny, but reasoning models
// burn the budget on chain-of-thought first; too small and content comes back
// empty. Generous cap — non-reasoning models still stop early once done.
const AI_ANSWER_MAX_TOKENS = 2048;

function resolveAICreds(modelId?: string): AICreds {
  type CredsRow = { model_id: string; api_key: string; base_url: string; timeout_ms: number };
  const override = modelId?.trim();
  let row: CredsRow | undefined;

  // Pinned default: an exact ai_models row, so the same model under a second
  // supplier (e.g. another account of the same provider) can be the primary
  if (!override) {
    const pinnedId = Number(getAiSetting('ai_default_model_id', '', ''));
    if (pinnedId) {
      row = db.prepare(`
        SELECT m.model_id, s.api_key, s.base_url, s.timeout_ms
        FROM ai_models m JOIN ai_suppliers s ON s.id = m.supplier_id
        WHERE m.id = ?
      `).get(pinnedId) as CredsRow | undefined;
    }
  }

  const model = override || row?.model_id || getAiSetting('ai_model', 'AI_MODEL', 'nvidia/nemotron-nano-12b-v2-vl:free');

  // Prefer a supplier with a non-empty key: the same model can exist under
  // multiple suppliers
  if (!row) {
    row = db.prepare(`
      SELECT m.model_id, s.api_key, s.base_url, s.timeout_ms
      FROM ai_models m JOIN ai_suppliers s ON s.id = m.supplier_id
      WHERE m.model_id = ?
      ORDER BY (s.api_key != '') DESC, m.id
      LIMIT 1
    `).get(model) as CredsRow | undefined;
  }

  return {
    modelId: model,
    // `||` not `??`: upgraded installs can have a seeded supplier with an empty
    // key while the real key lives in the legacy setting or AI_API_KEY env
    apiKey: row?.api_key || getAiSetting('ai_api_key', 'AI_API_KEY', ''),
    baseUrl: (row?.base_url ?? getAiSetting('ai_base_url', 'AI_BASE_URL', 'https://openrouter.ai/api/v1')).replace(/\/$/, ''),
    timeoutMs: row ? row.timeout_ms : Number(getAiSetting('ai_timeout_ms', 'AI_TIMEOUT_MS', '25000')),
  };
}

function getAllModelCreds(): AICreds[] {
  type Row = { model_id: string; api_key: string; base_url: string; timeout_ms: number };
  return (db.prepare(`
    SELECT m.model_id, s.api_key, s.base_url, s.timeout_ms
    FROM ai_models m JOIN ai_suppliers s ON s.id = m.supplier_id
    ORDER BY s.id, m.id
  `).all() as Row[]).map(r => ({
    modelId: r.model_id,
    apiKey: r.api_key,
    baseUrl: r.base_url.replace(/\/$/, ''),
    timeoutMs: r.timeout_ms,
  }));
}

async function callAIWithCreds(
  images: string[],
  prompt: string,
  maxTokens: number,
  creds: AICreds,
): Promise<{ response: string }> {
  if (!creds.apiKey) throw new Error('AI API key not configured — set it in Settings');

  const content: object[] = [];
  for (const img of images) content.push({ type: 'image_url', image_url: { url: img } });
  content.push({ type: 'text', text: prompt });

  const res = await fetch(`${creds.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: creds.modelId, messages: [{ role: 'user', content }], max_tokens: maxTokens }),
    signal: AbortSignal.timeout(creds.timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI API error ${res.status}: ${body}`);
  }

  const data = await res.json() as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  const choice = data.choices?.[0];
  const response = stripReasoning(choice?.message?.content ?? '');

  // Reasoning models spend the token budget on chain-of-thought; when it runs
  // out before any answer, content comes back empty with finish_reason 'length'
  if (!response && choice?.finish_reason === 'length') {
    throw new Error(
      `AI response truncated before an answer (finish_reason=length, max_tokens=${maxTokens}). ` +
      `The model "${creds.modelId}" is likely a reasoning model — try a larger token budget or a non-reasoning model.`,
    );
  }

  return { response };
}

/**
 * Strips chain-of-thought that reasoning models emit inline despite being told
 * not to, so the answer isn't buried in (or masked by) <think> blocks.
 */
function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '') // unterminated block (truncated response)
    .trim();
}

/** Generic AI call: sends images + prompt, returns the raw text response. */
export async function callAI(
  images: string[],
  prompt: string,
  maxTokens = 200,
  modelOverride?: string,
): Promise<{ response: string }> {
  return callAIWithCreds(images, prompt, maxTokens, resolveAICreds(modelOverride));
}

/**
 * Tries the default model first; on any API error, falls back to other configured
 * suppliers/models in order (if ai_fallback_enabled is true).
 */
async function callAIWithFallback(
  images: string[],
  prompt: string,
  maxTokens: number,
): Promise<{ response: string }> {
  const primary = resolveAICreds();
  const fallbackEnabled = getAiSetting('ai_fallback_enabled', '', 'true') === 'true';

  // Dedupe by full credentials, not model id: the same model under a different
  // supplier (e.g. a second account of the same provider) is a valid fallback
  const credsKey = (c: AICreds) => `${c.modelId}|${c.baseUrl}|${c.apiKey}`;
  const candidates: AICreds[] = [primary];
  if (fallbackEnabled) {
    const seen = new Set([credsKey(primary)]);
    for (const c of getAllModelCreds()) {
      if (seen.has(credsKey(c))) continue;
      seen.add(credsKey(c));
      candidates.push(c);
    }
  }

  let lastError: Error = new Error('AI API key not configured — set it in Settings');
  for (const creds of candidates) {
    if (!creds.apiKey) continue;
    try {
      return await callAIWithCreds(images, prompt, maxTokens, creds);
    } catch (err: any) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Returns true if a command template contains an {aiInput} or {aiInput:N} placeholder */
export function hasAiInput(template: string): boolean {
  return /\{aiInput(?::\d+)?\}/.test(template);
}

/** Extracts the expected length from {aiInput:N}, returns undefined for plain {aiInput} */
export function parseAiInputLength(template: string): number | undefined {
  const m = template.match(/\{aiInput:(\d+)\}/);
  return m ? parseInt(m[1], 10) : undefined;
}

type AiInputResult = { text: string; prompt: string; response: string };

/** Builds the captcha recognition prompt so callers can log it before the fetch. */
export function buildCaptchaPrompt(length?: number): string {
  const lengthHint = length ? ` The captcha is exactly ${length} characters.` : '';
  return `Read this captcha image.${lengthHint} Reply with ONLY the captcha characters(no space), nothing else.`;
}

/** Sends captcha image(s) to the AI and returns the recognised text only. */
export async function recognizeCaptchaWithAI(
  images: string[],
  length?: number,
): Promise<AiInputResult> {
  if (!resolveAICreds().apiKey) throw new Error('{aiInput} requires an AI API key — configure it in Settings');
  if (!images.length) throw new Error('{aiInput} requires an image in the previous message');

  const prompt = buildCaptchaPrompt(length);
  const { response: recognized } = await callAIWithFallback(images, prompt, AI_ANSWER_MAX_TOKENS);
  if (!recognized) throw new Error('AI returned empty response for captcha recognition');
  return { text: recognized, prompt, response: recognized };
}

type AiSelectionResult = { button: string; prompt: string; response: string; retries: string[] };

export async function selectButtonWithAI(
  buttons: string[][],
  html: string,
  images: string[],
  hint?: string,
  maxRetries = 0,
): Promise<AiSelectionResult> {
  if (!resolveAICreds().apiKey) throw new Error('{aiBtn} requires an AI API key — configure it in Settings');

  const flat = buttons.flat();
  const text = htmlToText(html);
  const task = hint ?? ('pick ONE button based on the message' + (images.length ? ' and attached image(s).' : ''));
  const prompt = `Task: "${task}".\n\nThe message:\n${text}\n\nThe available inline buttons are: ${JSON.stringify(flat)}\n\nWhich button should be clicked to "${task}"? If you don't know which button, please pick the most likely one. You MUST reply with ONLY the EXACT BUTTON TEXT from the available list, nothing else. Do NOT include any thinking logic.`;

  const effectiveMax = Math.min(maxRetries, 5); // hard cap to avoid exhausting AI credits
  const failedResponses: string[] = [];

  for (let attempt = 0; attempt <= effectiveMax; attempt++) {
    const { response: picked } = await callAIWithFallback(images, prompt, AI_ANSWER_MAX_TOKENS);
    if (!picked) throw new Error('AI API returned an empty response');

    const exact = flat.find(b => b === picked);
    if (exact) return { button: exact, prompt, response: picked, retries: failedResponses };
    const partial = flat.find(b => b.includes(picked) || picked.includes(b));
    if (partial) return { button: partial, prompt, response: picked, retries: failedResponses };
    // No match -- log this attempt and retry
    failedResponses.push(picked);
  }

  const err = new Error(`AI selected "${failedResponses.at(-1)}" but it does not match any available button after ${effectiveMax + 1} attempt(s): ${JSON.stringify(flat)}`);
  (err as any).aiRetries = failedResponses;
  (err as any).aiPrompt = prompt;
  (err as any).aiResponse = failedResponses.at(-1) ?? '';
  throw err;
}

type AiMultiSelectionResult = { buttons: string[]; prompt: string; response: string; retries: string[] };

/** Strips a Markdown code fence some models wrap JSON in (```json ... ``` or ``` ... ```). */
function stripCodeFence(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (m ? m[1] : text).trim();
}

/**
 * Like selectButtonWithAI but picks multiple buttons to click in order. The AI replies
 * with a JSON array of exact button texts (avoids delimiter-in-label ambiguity); every
 * entry must map to an available button or the attempt is retried.
 */
export async function selectMultipleButtonsWithAI(
  buttons: string[][],
  html: string,
  images: string[],
  hint?: string,
  maxRetries = 0,
): Promise<AiMultiSelectionResult> {
  if (!resolveAICreds().apiKey) throw new Error('The multiple-button click action requires an AI API key — configure it in Settings');

  const flat = buttons.flat();
  const text = htmlToText(html);
  const task = hint ?? ('pick the buttons that should be clicked based on the message' + (images.length ? ' and attached image(s).' : ''));
  const prompt = `Task: "${task}".\n\nThe message:\n${text}\n\nThe available inline buttons are: ${JSON.stringify(flat)}\n\nWhich button(s) should be clicked to "${task}", and in what order? You MUST reply with ONLY a JSON array of the EXACT BUTTON TEXTS to click, listed in click order, e.g. ["Button A", "Button B"]. Use ONLY texts from the available list. Do NOT include any other text or thinking logic.`;

  const effectiveMax = Math.min(maxRetries, 5); // hard cap to avoid exhausting AI credits
  const failedResponses: string[] = [];

  for (let attempt = 0; attempt <= effectiveMax; attempt++) {
    const { response: picked } = await callAIWithFallback(images, prompt, AI_ANSWER_MAX_TOKENS);
    if (!picked) throw new Error('AI API returned an empty response');

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(picked));
    } catch {
      failedResponses.push(picked);
      continue;
    }
    if (!Array.isArray(parsed) || !parsed.length || !parsed.every((e) => typeof e === 'string')) {
      failedResponses.push(picked);
      continue;
    }

    const matched: string[] = [];
    let ok = true;
    for (const entry of parsed as string[]) {
      const val = entry.trim();
      const btn = flat.find(b => b === val) ?? flat.find(b => b.includes(val) || val.includes(b));
      if (!btn) { ok = false; break; }
      matched.push(btn);
    }
    if (ok && matched.length) return { buttons: matched, prompt, response: picked, retries: failedResponses };
    failedResponses.push(picked);
  }

  const err = new Error(`AI selection "${failedResponses.at(-1)}" did not map to available buttons after ${effectiveMax + 1} attempt(s): ${JSON.stringify(flat)}`);
  (err as any).aiRetries = failedResponses;
  (err as any).aiPrompt = prompt;
  (err as any).aiResponse = failedResponses.at(-1) ?? '';
  throw err;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────


function messageToHtml(text: string, entities?: Api.TypeMessageEntity[]): string {
  if (!entities?.length) return escapeHtml(text).replace(/\n/g, '<br>');

  type Ins = { pos: number; html: string; isClose: boolean };
  const ins: Ins[] = [];

  for (const e of entities) {
    const end = e.offset + e.length;
    if (e instanceof Api.MessageEntityBold) {
      ins.push({ pos: e.offset, html: '<strong>', isClose: false });
      ins.push({ pos: end, html: '</strong>', isClose: true });
    } else if (e instanceof Api.MessageEntityItalic) {
      ins.push({ pos: e.offset, html: '<em>', isClose: false });
      ins.push({ pos: end, html: '</em>', isClose: true });
    } else if (e instanceof Api.MessageEntityCode) {
      ins.push({ pos: e.offset, html: '<code>', isClose: false });
      ins.push({ pos: end, html: '</code>', isClose: true });
    } else if (e instanceof Api.MessageEntityPre) {
      ins.push({ pos: e.offset, html: '<pre>', isClose: false });
      ins.push({ pos: end, html: '</pre>', isClose: true });
    } else if (e instanceof Api.MessageEntityUnderline) {
      ins.push({ pos: e.offset, html: '<u>', isClose: false });
      ins.push({ pos: end, html: '</u>', isClose: true });
    } else if (e instanceof Api.MessageEntityStrike) {
      ins.push({ pos: e.offset, html: '<s>', isClose: false });
      ins.push({ pos: end, html: '</s>', isClose: true });
    } else if (e instanceof Api.MessageEntityUrl) {
      const safe = safeHref(text.slice(e.offset, end));
      if (safe) {
        ins.push({ pos: e.offset, html: `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener">`, isClose: false });
        ins.push({ pos: end, html: '</a>', isClose: true });
      }
    } else if (e instanceof Api.MessageEntityTextUrl) {
      const safe = safeHref((e as Api.MessageEntityTextUrl).url ?? '');
      if (safe) {
        ins.push({ pos: e.offset, html: `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener">`, isClose: false });
        ins.push({ pos: end, html: '</a>', isClose: true });
      }
    } else if (e instanceof Api.MessageEntityBotCommand) {
      ins.push({ pos: e.offset, html: '<span style="color:#2563eb">', isClose: false });
      ins.push({ pos: end, html: '</span>', isClose: true });
    }
  }

  // Sort: by position; close tags before open tags at same position (correct nesting)
  ins.sort((a, b) => a.pos - b.pos || (a.isClose ? -1 : 1) - (b.isClose ? -1 : 1));

  let result = '';
  let pos = 0;
  for (const { pos: iPos, html } of ins) {
    if (iPos > pos) result += escapeHtml(text.slice(pos, iPos));
    result += html;
    pos = iPos;
  }
  result += escapeHtml(text.slice(pos));
  return result.replace(/\n/g, '<br>');
}

// Renders a Telegram web page preview as inline HTML (inline styles required for v-html)
function webpageToHtml(wp: Api.WebPage): string {
  const site = escapeHtml(wp.siteName || wp.displayUrl || '');
  const title = escapeHtml(wp.title ?? '');
  const desc = escapeHtml(wp.description ?? '');
  let html = '<div style="border-left:3px solid #4a9eff;padding:3px 0 3px 8px;margin-top:6px;font-size:12px;line-height:1.4">';
  if (site) html += `<div style="color:#4a9eff;font-weight:500">${site}</div>`;
  if (title) html += `<div style="font-weight:600;color:#111">${title}</div>`;
  if (desc) html += `<div style="color:#555;margin-top:1px">${desc}</div>`;
  html += '</div>';
  return html;
}

// Extracts display data from a set of bot messages
export async function parseMessages(
  messages: Api.Message[],
  client: TelegramClient,
  signal?: AbortSignal,
): Promise<ParsedMessages> {
  const hasMedia = messages.some(
    m => m.media instanceof Api.MessageMediaPhoto || m.media instanceof Api.MessageMediaDocument,
  );

  const htmlParts: string[] = [];
  for (const m of messages) {
    const textHtml = messageToHtml(m.message, m.entities as Api.TypeMessageEntity[] | undefined);
    let msgHtml = textHtml;
    if (m.media instanceof Api.MessageMediaWebPage && m.media.webpage instanceof Api.WebPage) {
      msgHtml += webpageToHtml(m.media.webpage);
    }
    if (msgHtml.trim()) htmlParts.push(msgHtml);
  }
  const html = htmlParts.join('<hr style="margin:8px 0;border:none;border-top:1px solid #d0d0d0">');

  const buttons: string[][] = [];
  const buttonsMsg = [...messages].reverse().find(m => (m as any).replyMarkup instanceof Api.ReplyInlineMarkup);
  if (buttonsMsg) {
    const markup = (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup;
    for (const row of markup.rows) {
      const rowTexts = row.buttons.map(btn => (btn as any).text as string).filter(Boolean);
      if (rowTexts.length) buttons.push(rowTexts);
    }
  }

  const images: string[] = [];
  if (!signal?.aborted) {
    for (const m of messages) {
      if (!(m.media instanceof Api.MessageMediaPhoto)) continue;
      try {
        const photo = m.media.photo;
        if (photo instanceof Api.Photo) {
          const mSize = photo.sizes.find(
            (s): s is Api.PhotoSize => s instanceof Api.PhotoSize && s.type === 'm'
          ) ?? photo.sizes[1] ?? photo.sizes[0];
          if (mSize) {
            const bytes = await client.downloadMedia(m, { thumb: mSize }) as Buffer | undefined;
            if (bytes) images.push(`data:image/jpeg;base64,${bytes.toString('base64')}`);
          }
        }
      } catch { /* skip image on error */ }
    }
  }

  return { html, hasMedia, images, buttons };
}

// Finds an openable inline button that carries a web address rather than a
// callback: a URL button (e.g. "我不是机器人") or a Mini App button (e.g. FutureEcho's
// "🔐 Verify", or a "打开小程序签到" checkin app). Mini App buttons are flagged so the
// caller can have Telegram sign the URL before opening it. When `matchText` is given,
// only a button whose label carries it is returned -- `|`-separated wordings match
// whichever one the bot rendered, for a bot that follows the account's language.
export function findUrlButton(msg: Api.Message | undefined, matchText?: string): WebButton | undefined {
  const markup = (msg as any)?.replyMarkup;
  if (!(markup instanceof Api.ReplyInlineMarkup)) return undefined;
  for (const row of markup.rows) {
    for (const btn of row.buttons) {
      const web = webButtonOf(btn);
      if (!web) continue;
      if (matchesAnyLabel(web.text, matchText)) return web;
    }
  }
  return undefined;
}

/**
 * Collects the bot's messages and resolves once one carries buttons; on timeout it rejects
 * with what it collected, so the caller can still show the reply and judge it by text.
 *
 * Edits count as arrivals too. A bot that posts its text first and only then edits that same
 * message to attach the keyboard would otherwise never be seen to have sent buttons at all,
 * and the run would time out with the reply sitting in front of it. An edit replaces the copy
 * already collected, so the text judged on timeout is the message as it finally read.
 */
function waitForBotReply(
  client: TelegramClient,
  botUsername: string,
  timeoutMs: number,
  signal?: AbortSignal,
  botPeerId?: string,
): Promise<Api.Message[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Job cancelled')); return; }

    const collected: Api.Message[] = [];

    const cleanup = () => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(editHandler, new Raw({}));
      signal?.removeEventListener('abort', onAbort);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new BotReplyTimeoutError(timeoutMs, collected));
    }, timeoutMs);

    const onAbort = () => { cleanup(); reject(new Error('Job cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const consider = (msg: Api.Message, fromEdit = false) => {
      const at = collected.findIndex(c => c.id === msg.id);
      // An edit only speaks for a message this wait watched arrive. Anything else in the chat
      // -- the bot editing something it posted yesterday -- is not the reply to this command.
      if (fromEdit && at < 0) return;
      if (at >= 0) collected[at] = msg;
      else collected.push(msg);
      // Use replyMarkup (raw TLObject field) instead of msg.buttons getter, which
      // requires inputChat to be resolved and silently returns undefined when it isn't.
      if ((msg as any).replyMarkup) { cleanup(); resolve(collected); }
    };

    const handler = async (event: NewMessageEvent) => consider(event.message as Api.Message);

    const editHandler = async (update: any) => {
      const isEdit =
        update.className === 'UpdateEditMessage' ||
        update.className === 'UpdateEditChannelMessage';
      if (!isEdit) return;
      const msg = update.message as Api.Message;
      if (!msg || msg.out) return;
      // Without the bot's own chat id an edit from anywhere would be taken for its reply
      if (!botPeerId || !msg.peerId || utils.getPeerId(msg.peerId) !== botPeerId) return;
      consider(msg, true);
    };

    client.addEventHandler(handler, new NewMessage({ fromUsers: [botUsername] }));
    client.addEventHandler(editHandler, new Raw({}));
  });
}

// Watches for an in-place edit of a specific message (bot edits the original reply).
// Uses raw Telegram updates since GramJS has no dedicated EditedMessage event.
// Never rejects -- resolves null on timeout or abort.
export function waitForBotMessageEdit(
  client: TelegramClient,
  originalMsgId: number,
  maxMs: number,
  signal?: AbortSignal,
  peerId?: string,
): Promise<Api.Message | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }

    const finish = (msg: Api.Message | null) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new Raw({}));
      signal?.removeEventListener('abort', onAbort);
      resolve(msg);
    };

    const timer = setTimeout(() => finish(null), maxMs);
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });

    const handler = async (update: any) => {
      const isEdit =
        update.className === 'UpdateEditMessage' ||
        update.className === 'UpdateEditChannelMessage';
      if (isEdit) {
        const msg = update.message as Api.Message;
        // Catch any inbound edit from the bot (not our own outgoing messages).
        // Some bots edit a different message than the one that had the buttons.
        if (!msg || msg.out) return;
        // When a peer filter is given, ignore edits from unrelated chats
        if (peerId && (!msg.peerId || utils.getPeerId(msg.peerId) !== peerId)) return;
        finish(msg);
      }
    };

    client.addEventHandler(handler, new Raw({}));
  });
}

// Waits for any new message from the bot within the given timeout.
// Never rejects -- resolves null on timeout or abort.
export function waitForNewBotMessage(
  client: TelegramClient,
  botUsername: string,
  maxMs: number,
  signal?: AbortSignal,
): Promise<Api.Message | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }

    const finish = (msg: Api.Message | null) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      signal?.removeEventListener('abort', onAbort);
      resolve(msg);
    };

    const timer = setTimeout(() => finish(null), maxMs);
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });

    const handler = async (event: NewMessageEvent) => {
      finish(event.message as Api.Message);
    };

    client.addEventHandler(handler, new NewMessage({ fromUsers: [botUsername] }));
  });
}

export type SpamStatus = "free" | "limited" | "blocked" | "frozen" | "unknown";

/** How a spam status was decided, kept for diagnostics and for the unknown-reply record. */
export type SpamSource = "signature" | "buttons" | "text" | "ai" | "unknown";

/** The @SpamBot /start reply reduced to the parts the classifier looks at. */
export type SpamReply = { text: string; buttons: string[] };

/**
 * SpamBot answers in the account's own language, so the wording is unreliable. The reply
 * keyboard is not: the same status offers the same buttons in every language, only the
 * labels change. Classification therefore runs structure first, wording second, AI last:
 *
 *   1. button signature -- an exact keyboard seen before (seeded below, then learned)
 *   2. button count     -- four buttons is only ever the "limited" keyboard
 *   3. text keywords    -- English (and a few confirmed translations)
 *   4. AI               -- one small text call, whose answer is learned as a signature
 */
const buttonSignature = (buttons: string[]): string =>
  buttons.map((b) => b.trim().toLowerCase()).join(" | ");

// Signatures confirmed against real replies. Learned ones are added to the settings row.
const SEEDED_SIGNATURES: Record<string, SpamStatus> = {
  [buttonSignature(["Cool, thanks", "But I can’t message non-contacts!"])]: "free",
  [buttonSignature(["Хорошо, спасибо", "Но я не могу писать неконтактам"])]: "free",
  [buttonSignature(["I won't do it again", "My account was hacked"])]: "blocked",
  [buttonSignature(["OK", "What is spam?", "I was wrong, please release me", "This is a mistake"])]: "limited",
  [buttonSignature(["OK", "¿Qué es el spam?", "Me equivoqué. Por favor, libérame", "Esto es un error"])]: "limited",
};

const SIGNATURE_SETTING = "spam_button_signatures";

// A learned entry keeps the reply it came from: the verdict behind it is the AI's, so it
// has to stay auditable (and correctable) once cached.
type LearnedSignature = { status: SpamStatus; sample: string; learnedAt: string };

function learnedSignatures(): Record<string, LearnedSignature> {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(SIGNATURE_SETTING) as
      | { value: string }
      | undefined;
    const parsed = row ? JSON.parse(row.value) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function learnSignature(signature: string, status: SpamStatus, sample: string): void {
  if (!signature || status === "unknown") return;
  try {
    const next = {
      ...learnedSignatures(),
      [signature]: { status, sample: sample.slice(0, 300), learnedAt: new Date().toISOString() },
    };
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(SIGNATURE_SETTING, JSON.stringify(next));
  } catch { /* a signature that can't be cached just costs one more AI call */ }
}

function parseSpamStatus(text: string): SpamStatus {
  const lower = text.toLowerCase();
  if (lower.includes("good news") || lower.includes("no limits") || lower.includes("free as a bird")) return "free";
  if (lower.includes("permanently") || lower.includes("banned") || lower.includes("suspended")) return "blocked";
  if (lower.includes("blocked for violations")) return "blocked";
  // SpamBot says "blocked" for frozen accounts (temporary restriction, not a permanent ban)
  if (lower.includes("frozen") || lower.includes("blocked")) return "frozen";
  if (lower.includes("limited")) return "limited";
  // Confirmed non-English wordings; full phrases, since the roots for "limited" and
  // "no limits" are shared and a substring match picks the wrong one.
  if (lower.includes("свободен от каких-либо ограничений")) return "free";
  if (lower.includes("никаких ограничений")) return "free";
  if (lower.includes("sin límites") || lower.includes("libre como un pájaro")) return "free";
  if (lower.includes("cuenta fue limitada") || lower.includes("cuenta está limitada")) return "limited";
  if (lower.includes("ваш аккаунт ограничен") || lower.includes("аккаунт был ограничен")) return "limited";
  return "unknown";
}

/**
 * SpamBot answers a failed request with a generic service error instead of a standing
 * ("Sorry, an error has occurred during your request. Please try again later. (Code 628117466)").
 * It carries no keyboard and no verdict, so it must not reach the text or AI passes -- the AI
 * reads "error" as a restriction and the wrong verdict then gets cached as a signature.
 */
export function isSpamServiceError(text: string): boolean {
  const lower = text.toLowerCase();
  // The numeric code suffix is language-independent; the wordings are the confirmed English ones.
  if (/\(\s*code[:\s]*\d{4,}\s*\)/i.test(text)) return true;
  return lower.includes("an error has occurred") || lower.includes("please try again later");
}

/** Language-independent pass: an exact keyboard match, then the button count. */
function classifyByButtons(buttons: string[]): SpamStatus {
  if (!buttons.length) return "unknown";
  const signature = buttonSignature(buttons);
  const hit = learnedSignatures()[signature]?.status ?? SEEDED_SIGNATURES[signature];
  if (hit) return hit;
  // Four buttons is the limited keyboard (OK / what is spam / release me / mistake); the
  // free and blocked keyboards both have two, so a count of two decides nothing.
  return buttons.length === 4 ? "limited" : "unknown";
}

const SPAM_AI_PROMPT = `A Telegram user sent /start to @SpamBot and got the reply below, which may be in any language.
Classify the account's standing as exactly one of these words:
free - no limits apply to the account
limited - the account is restricted from messaging non-contacts, permanently or until a date
blocked - the account was blocked or banned for violating the Terms of Service
frozen - the account is frozen and under review
unknown - the reply states no standing at all (an error, a service message, anything unrelated)
Answer with one word only, nothing else.`;

async function classifySpamWithAi(reply: SpamReply): Promise<SpamStatus> {
  const buttons = reply.buttons.length ? `\n\nReply keyboard buttons: ${reply.buttons.join(" / ")}` : "";
  // Same fallback chain as the captcha path: a dead primary supplier shouldn't
  // turn every non-English reply into an unknown.
  const { response } = await callAIWithFallback(
    [],
    `${SPAM_AI_PROMPT}\n\n---\n${reply.text}${buttons}\n---`,
    AI_ANSWER_MAX_TOKENS,
  );
  return parseAiSpamAnswer(response);
}

/**
 * Only the answer line counts. A model that talks around it ("not limited, so free") would
 * otherwise be read by whichever word came first, and a wrong verdict here gets cached.
 */
export function parseAiSpamAnswer(response: string): SpamStatus {
  const last = response.trim().split("\n").filter((l) => l.trim()).pop() ?? "";
  const words = last.toLowerCase().match(/free|limited|blocked|frozen/g) ?? [];
  return words.length === 1 ? (words[0] as SpamStatus) : "unknown";
}

/**
 * Decides the status without touching the network. Exported for the tests and for
 * callers that already hold a reply.
 */
export function classifySpamReply(reply: SpamReply): { status: SpamStatus; source: SpamSource } {
  if (isSpamServiceError(reply.text)) return { status: "unknown", source: "unknown" };
  const byButtons = classifyByButtons(reply.buttons);
  if (byButtons !== "unknown") {
    return { status: byButtons, source: reply.buttons.length === 4 ? "buttons" : "signature" };
  }
  const byText = parseSpamStatus(reply.text);
  if (byText !== "unknown") return { status: byText, source: "text" };
  return { status: "unknown", source: "unknown" };
}

/** Structure and wording first, then one AI call; a resolved keyboard is remembered. */
export async function resolveSpamStatus(
  reply: SpamReply,
): Promise<{ status: SpamStatus; source: SpamSource; aiError?: string }> {
  const local = classifySpamReply(reply);
  if (local.status !== "unknown") return local;
  // A service error has nothing to classify; asking the AI only invents a verdict.
  if (isSpamServiceError(reply.text)) return local;

  try {
    const status = await classifySpamWithAi(reply);
    if (status !== "unknown") {
      if (reply.buttons.length) learnSignature(buttonSignature(reply.buttons), status, reply.text);
      return { status, source: "ai" };
    }
    return { status: "unknown", source: "unknown" };
  } catch (err: any) {
    return { status: "unknown", source: "unknown", aiError: err?.message ?? String(err) };
  }
}

/** The button labels of a reply keyboard (SpamBot never uses inline buttons here). */
function replyKeyboardButtons(msg: Api.Message): string[] {
  const markup = (msg as any).replyMarkup;
  if (!(markup instanceof Api.ReplyKeyboardMarkup)) return [];
  return markup.rows.flatMap((row: any) =>
    row.buttons.map((btn: any) => String(btn.text ?? "")).filter(Boolean),
  );
}

export async function checkSpamStatus(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<{ spamStatus: SpamStatus; rawMessage: string; buttons: string[]; source: SpamSource; aiError?: string }> {
  const SPAM_BOT = "SpamBot";
  const TIMEOUT_MS = 25_000;

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: false,
    baseLogger: new Logger(LogLevel.NONE),
    ...(proxy ? { proxy } : {}),
    ...(deviceParams ?? {}),
  });

  // Connect, ask and tear down under one bound: an unreachable proxy otherwise leaves the
  // connect pending forever, which stalls the account and every one queued behind it.
  const { rawMessage, buttons } = await withTgClient(client, "spam check", async (c) => {
    // Set up listener BEFORE sending to avoid missing a fast reply
    const replyPromise = new Promise<{ text: string; id: number; buttons: string[] }>((resolve, reject) => {
      let done = false;

      const finish = (result: { text: string; id: number; buttons: string[] } | Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        c.removeEventHandler(handler, new NewMessage({}));
        if (result instanceof Error) reject(result);
        else resolve(result);
      };

      const timer = setTimeout(() => finish(new Error("SpamBot did not reply in time")), TIMEOUT_MS);

      const handler = async (event: NewMessageEvent) => {
        const msg = event.message as Api.Message;
        const text = (msg.message ?? "").trim();
        if (text) finish({ text, id: msg.id, buttons: replyKeyboardButtons(msg) });
      };

      c.addEventHandler(handler, new NewMessage({ fromUsers: [SPAM_BOT] }));
    });

    await c.sendMessage(SPAM_BOT, { message: "/start" });
    const { text, id: replyId, buttons: keyboard } = await replyPromise;

    // Mark SpamBot conversation as read so it doesn't show as unread in the chat list
    try {
      const spamBotEntity = await c.getEntity(SPAM_BOT);
      await c.invoke(new Api.messages.ReadHistory({ peer: spamBotEntity, maxId: replyId }));
    } catch { /* non-critical, ignore */ }

    return { rawMessage: text, buttons: keyboard };
  });

  // Classified after the connection is closed: this may call out to an AI provider, and
  // holding a Telegram connection open for it buys nothing.
  const { status, source, aiError } = await resolveSpamStatus({ text: rawMessage, buttons });
  return { spamStatus: status, rawMessage, buttons, source, ...(aiError ? { aiError } : {}) };
}

export async function runCheckin(
  apiId: number,
  apiHash: string,
  sessionString: string,
  botUsername: string,
  replyTimeoutMs = 40_000,
  startCommand = '/start',
  checkinButton = '签到',
  attempt = 1,
  maxAiRetries = 0,
  signal?: AbortSignal,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
  successContains?: string,
  failContains?: string,
  webProxyUrl?: string,
): Promise<CheckinAttemptLog> {
  const attemptStart = Date.now();
  const log: CheckinAttemptLog = {
    attempt, commandSent: startCommand, hasMedia: false,
    commandResponseHtml: '', availableButtons: [] as string[][],
    replyTimeoutMs,
  };

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: false,
    baseLogger: new Logger(LogLevel.NONE),
    ...(proxy ? { proxy } : {}),
    ...(deviceParams ?? {}),
  });

  const t_connect = Date.now();
  await connectWithTimeout(client, 'checkin');
  log.connectMs = Date.now() - t_connect;

  const assertOutcome = (...texts: string[]): void => {
    if (!successContains && !failContains) return;
    const joined = texts.filter(Boolean).join('\n');
    if (textSaysFail(joined, failContains)) {
      throw new Error(`Reply indicates failure: "${failContains}" detected`);
    }
    if (!textSaysSuccess(joined, successContains)) {
      throw new Error(`Expected success indicator "${successContains}" not found in response`);
    }
  };

  /**
   * Whether the configured outcome texts already settle this run, either way. Used where no
   * buttons message ever arrives: a bot that does the whole check-in from the command replies
   * with text alone, and that text is the result the job was told to look for.
   */
  const outcomeDecided = (text: string): boolean =>
    textSaysFail(text, failContains) ||
    (!!successContains && textSaysSuccess(text, successContains));

  try {
    if (signal?.aborted) throw new Error('Job cancelled');
    const expandedCommand = expandCommand(startCommand);
    log.commandSent = expandedCommand; // record what was actually sent, not the template
    // Before the wait starts: an edit update names its chat by id, and the wait has to know
    // which id is the bot's to tell its edits from any other chat's. Not worth failing a run
    // over: without it edits are simply ignored, exactly as they were before, and an
    // unresolvable username still fails where it always did, on the send below.
    const botPeerId = await client.getPeerId(botUsername).catch(() => undefined);
    const replyPromise = waitForBotReply(client, botUsername, replyTimeoutMs, signal, botPeerId);
    const t_send = Date.now();
    await client.sendMessage(botUsername, { message: expandedCommand });

    let messages: Api.Message[];
    try {
      messages = await replyPromise;
      log.replyLatencyMs = Date.now() - t_send;
    } catch (err) {
      log.replyLatencyMs = Date.now() - t_send;
      if (!(err instanceof BotReplyTimeoutError) || !err.partial.length) throw err;

      const parsed = await parseMessages(err.partial, client, signal);
      log.hasMedia = parsed.hasMedia;
      log.commandResponseHtml = parsed.html;
      log.commandResponseImages = parsed.images;
      log.availableButtons = parsed.buttons;

      // The bot did reply, just with no buttons to press -- which is how a bot that completes
      // the check-in from the command alone answers. Where that reply carries the success or
      // failure text this job was told to look for, it is the outcome, and reporting the wait
      // for a buttons message as a timeout marked a check-in that plainly worked as failed.
      if (!outcomeDecided(htmlToText(parsed.html))) throw err;
      assertOutcome(htmlToText(parsed.html));
      log.totalMs = Date.now() - attemptStart;
      return log;
    }

    const parsed = await parseMessages(messages, client, signal);
    log.hasMedia = parsed.hasMedia;
    log.commandResponseHtml = parsed.html;
    log.commandResponseImages = parsed.images;
    log.availableButtons = parsed.buttons;

    const buttonsMsg = [...messages].reverse().find(m => (m as any).replyMarkup instanceof Api.ReplyInlineMarkup);
    if (!buttonsMsg) {
      // A reply carrying a plain keyboard rather than an inline one has nothing to press
      // either, so the outcome texts settle it the same way as above.
      if (!outcomeDecided(htmlToText(parsed.html))) {
        throw new Error('No message with buttons received');
      }
      assertOutcome(htmlToText(parsed.html));
      log.totalMs = Date.now() - attemptStart;
      return log;
    }

    if (signal?.aborted) throw new Error('Job cancelled');

    const markup = (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup;
    const allBtnRows = markup.rows;

    // Resolve target button text and match mode
    let targetText: string;
    let useExactMatch: boolean;

    if (checkinButton === '{anyBtn}') {
      const flat = allBtnRows.flatMap(row => row.buttons.map((btn: any) => btn.text as string));
      if (!flat.length) throw new Error('No buttons available for {anyBtn}');
      targetText = flat[Math.floor(Math.random() * flat.length)];
      useExactMatch = true;
    } else if (isAiBtn(checkinButton)) {
      const aiStart = Date.now();
      const hint = parseAiBtnHint(checkinButton);
      const aiResult = await selectButtonWithAI(log.availableButtons, log.commandResponseHtml, parsed.images, hint, maxAiRetries);
      targetText = aiResult.button;
      log.aiDurationMs = Date.now() - aiStart;
      log.aiPrompt = aiResult.prompt;
      log.aiResponse = aiResult.response;
      if (aiResult.retries.length) log.aiRetries = aiResult.retries;
      useExactMatch = true;
    } else {
      targetText = checkinButton;
      useExactMatch = false;
    }

    const peer = await client.getInputEntity(botUsername);
    let clicked = false;
    // Set when the checkin completes by opening a web URL behind Cloudflare
    // (e.g. a "我不是机器人" link) rather than by a callback.

    for (const row of allBtnRows) {
      for (const btn of row.buttons) {
        const btnText = (btn as any).text as string;
        const matches = useExactMatch ? btnText === targetText : btnText.includes(targetText);
        if (matches) {
          // A URL or Mini App button carries a web address rather than a callback, so
          // there is nothing here to press. Opening it belongs to a custom job, whose
          // browser actions sign a Mini App and drive the page properly.
          const web = webButtonOf(btn);
          if (web) {
            throw new Error(
              `Checkin button "${btnText}" opens ${web.miniApp ? 'a Mini App' : 'a web page'}, ` +
                'which a checkin job cannot do. Use a custom job with an ' +
                `"Open ${web.miniApp ? 'Mini App' : 'URL'}" action instead.`,
            );
          }
          if (!(btn instanceof Api.KeyboardButtonCallback)) {
            const typeName = (btn as any).className ?? btn.constructor?.name ?? 'unknown';
            throw new Error(
              `Button "${btnText}" is a ${typeName}, not a callback button — only KeyboardButtonCallback can be clicked automatically`,
            );
          }

          // Start watching BEFORE invoking to avoid missing a fast response.
          // Edit listener catches any inbound bot edit (not just the buttons message).
          const editPromise = waitForBotMessageEdit(client, buttonsMsg.id, replyTimeoutMs, signal, botPeerId);
          const newMsgPromise = waitForNewBotMessage(client, botUsername, replyTimeoutMs, signal);

          const preClickEditDate = (buttonsMsg as any).editDate as number | undefined;
          const t_click = Date.now();
          let answer: Api.messages.BotCallbackAnswer | null = null;
          let callbackTimedOut = false;
          try {
            answer = await client.invoke(new Api.messages.GetBotCallbackAnswer({
              peer,
              msgId: buttonsMsg.id,
              data: btn.data,
            })) as Api.messages.BotCallbackAnswer;
          } catch (err: any) {
            // BOT_RESPONSE_TIMEOUT means the click reached the bot but it never called
            // answerCallbackQuery -- the check-in may still have registered (the bot edits
            // the message or acts via a follow-up Cloudflare page). Fall through and let
            // the edit/new-message watchers below decide.
            if (!err?.message?.includes('BOT_RESPONSE_TIMEOUT')) throw err;
            callbackTimedOut = true;
          }
          log.buttonClickMs = Date.now() - t_click;
          log.buttonClicked = btnText;
          if (answer?.message) log.callbackAnswer = answer.message;
          console.log(`[checkin] callback answer: message="${answer?.message ?? ''}" url="${(answer as any)?.url ?? ''}" alert=${(answer as any)?.alert ?? false}`);
          clicked = true;

          // If the bot already confirmed via toast (answer.message), allow a short
          // grace window for any follow-up edit/message; otherwise wait longer.
          const capMs = answer?.message
            ? Math.min(replyTimeoutMs, 5_000)
            : Math.min(replyTimeoutMs, 30_000);
          const capPromise = new Promise<{ msg: null; src: 'cap' }>(r =>
            setTimeout(() => r({ msg: null, src: 'cap' }), capMs),
          );

          // Take whichever response arrives first; track the source for dev logs
          const t_resp = Date.now();
          const taggedEdit = editPromise.then(m => ({ msg: m, src: 'edit' as const }));
          const taggedNew = newMsgPromise.then(m => ({ msg: m, src: 'new_message' as const }));
          const { msg: responseMsg, src: respSrc } = await Promise.race([taggedEdit, taggedNew, capPromise]);
          log.buttonResponseMs = Date.now() - t_resp;
          if (responseMsg && !signal?.aborted) {
            log.buttonResponseSource = respSrc;
            const bp = await parseMessages([responseMsg], client, signal);
            if (bp.html || bp.hasMedia) {
              log.buttonResponseHtml = bp.html || undefined;
              log.buttonResponseHasMedia = bp.hasMedia || undefined;
              log.buttonResponseImage = bp.images[0];
              log.buttonResponseButtons = bp.buttons.length ? bp.buttons : undefined;
            }
          }

          // A timed-out callback only counts as a failure if the bot never reacted. If no
          // edit/new message was seen live, re-fetch the message: a changed editDate proves
          // the bot processed the click and the check-in registered.
          if (callbackTimedOut && !responseMsg && !signal?.aborted) {
            const fresh = await client
              .getMessages(botUsername, { ids: [buttonsMsg.id] })
              .then(r => (r as Api.Message[])?.[0] ?? null)
              .catch(() => null);
            const freshEditDate = (fresh as any)?.editDate as number | undefined;
            const wasEdited = !!fresh && !!freshEditDate && freshEditDate !== preClickEditDate;
            if (!wasEdited) {
              throw new Error(`Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`);
            }
            log.buttonResponseSource = 'edit';
            const bp = await parseMessages([fresh!], client, signal);
            if (bp.html || bp.hasMedia) {
              log.buttonResponseHtml = bp.html || undefined;
              log.buttonResponseHasMedia = bp.hasMedia || undefined;
              log.buttonResponseImage = bp.images[0];
              log.buttonResponseButtons = bp.buttons.length ? bp.buttons : undefined;
            }
          }
          break;
        }
      }
      if (clicked) break;
    }

    const notFoundLabel = isAiBtn(checkinButton) ? `{aiBtn} -> "${targetText}"` : `"${checkinButton}"`;
    if (!clicked) throw new Error(`Button ${notFoundLabel} not found in bot reply`);

    // Check success/fail text in the callback answer and the button's reply
    assertOutcome(log.callbackAnswer ?? '', htmlToText(log.buttonResponseHtml ?? ''));

    log.totalMs = Date.now() - attemptStart;
    return log;
  } catch (err: any) {
    log.error = err?.message ?? String(err);
    log.errorName = err?.name ?? err?.constructor?.name;
    log.totalMs = Date.now() - attemptStart;
    if (Array.isArray(err?.aiRetries) && err.aiRetries.length) log.aiRetries = err.aiRetries;
    throw new CheckinError(log.error!, log);
  } finally {
    // GramJS throws TIMEOUT when the update loop stops; always swallow here.
    // destroy, not disconnect -- only destroy stops the ping loop (issue #14).
    // Bounded: teardown runs over the same connection, so a dead proxy would hang it too.
    await destroyQuietly(client, 'checkin');
  }
}
