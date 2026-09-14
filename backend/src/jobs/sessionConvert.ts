import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { readZip } from "../system/zipRead";

// Redeems a 卡密 (a "phone----getcode-URL" card line) at a card-to-session converter, which
// turns it into the account's real login files: a Telethon .session, a .json of api/device
// metadata, and an opaque .passkey blob. The card itself is never a session -- the service
// holds the account and hands back its credentials. See project_tg_getcode_accounts memory.
//
// The converter's base URL is not baked in: it is supplied per import (see SessionImportOptions)
// so the service address is never committed to the repo. Two calls matter: alive-check screens
// a card before conversion (the service warns that downloading forfeits free replacement, so a
// dead card must be caught first), and submit produces a downloadable zip. Everything is
// form-urlencoded and wants a browser-ish Referer/UA or the edge rejects it.

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Validate and normalise a caller-supplied converter base URL to "scheme://host[:port]". */
export function normaliseConverterBase(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) throw new Error("A converter URL is required");
  let url: URL;
  try {
    // Prepend https only when no scheme is present at all; a non-http scheme is left as-is so
    // the protocol check below rejects it rather than being silently wrapped.
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new Error(`Invalid converter URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Converter URL must be http(s): ${value}`);
  }
  return url.origin;
}

function headersFor(base: string) {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${base}/`,
    "User-Agent": BROWSER_UA,
  };
}

/** The converter's own liveness verdict for one card. `normal` is the only usable state. */
export type AliveStatus = "normal" | "frozen" | "dead" | "unknown";

function normaliseAlive(status: unknown): AliveStatus {
  const s = String(status ?? "").toLowerCase();
  if (s === "normal" || s === "active" || s === "ok" || s === "alive") return "normal";
  if (s.includes("frozen") || s.includes("冻结")) return "frozen";
  if (s.includes("dead") || s.includes("掉线") || s.includes("死")) return "dead";
  return "unknown";
}

async function postForm(
  base: string,
  endpoint: string,
  body: Record<string, string>,
  timeoutMs = 120_000,
): Promise<any> {
  const params = new URLSearchParams(body).toString();
  const resp = await fetch(`${base}${endpoint}`, {
    method: "POST",
    headers: headersFor(base),
    body: params,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Converter returned non-JSON (HTTP ${resp.status})${text ? `: ${text.slice(0, 120)}` : ""}`,
    );
  }
  if (!resp.ok || !data || data.status !== true) {
    throw new Error(data?.message || `Converter request failed (HTTP ${resp.status})`);
  }
  return data;
}

/** Screen one card for liveness before spending its one-shot conversion. */
export async function aliveCheck(
  base: string,
  cardLine: string,
): Promise<AliveStatus> {
  const data = await postForm(base, "/api/session/alive-check", {
    carmi: cardLine,
  });
  return normaliseAlive(data?.result?.status);
}

export type ConvertSubmitResult = {
  downloadUrl: string;
  uuidCount: number;
  zipName: string;
};

/**
 * Convert a set of cards in one call (the site batches by <=100 uuids -- callers should chunk).
 * `includeTdata` also packs a tdesktop tdata folder per account; off by default since Bemby
 * only needs the session.
 */
export async function submitCards(
  base: string,
  cardLines: string[],
  includeTdata = false,
): Promise<ConvertSubmitResult> {
  const data = await postForm(
    base,
    "/api/session/submit",
    {
      raw_text: cardLines.join("\n"),
      frontend_key: "",
      include_tdata: includeTdata ? "1" : "0",
    },
    180_000,
  );
  const downloadUrl = String(data.download_url ?? "");
  if (!downloadUrl) throw new Error("Converter succeeded but returned no download URL");
  return {
    downloadUrl,
    uuidCount: Number(data.uuid_count ?? 0) || 0,
    zipName: String(data.merged_zip_name ?? "session.zip"),
  };
}

export async function downloadZip(base: string, url: string): Promise<Buffer> {
  const abs = /^https?:\/\//i.test(url) ? url : `${base}${url.startsWith("/") ? "" : "/"}${url}`;
  const resp = await fetch(abs, {
    headers: { "User-Agent": BROWSER_UA, Referer: `${base}/` },
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) throw new Error(`Download failed (HTTP ${resp.status})`);
  return Buffer.from(await resp.arrayBuffer());
}

/** The api_id/hash + device fingerprint the vendor logged the account in with. */
export type SessionJsonMeta = {
  phone: string;
  apiId: number;
  apiHash: string;
  twoFa: string;
  deviceModel?: string;
  systemVersion?: string;
  appVersion?: string;
  systemLangCode?: string;
  langPack?: string;
  uuid?: string;
};

/** One account's files as found inside a converted archive. */
export type ConvertedAccount = {
  phone: string;
  /** GramJS string session, re-encoded from the Telethon .session. */
  sessionString: string;
  dcId: number;
  meta: SessionJsonMeta;
};

const ZIP_LIMITS = {
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntries: 2000,
};

function baseName(name: string): string {
  const cut = name.replace(/\\/g, "/");
  return cut.slice(cut.lastIndexOf("/") + 1);
}

function parseJsonMeta(raw: Buffer): SessionJsonMeta {
  const j = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  const apiId = Number(j.api_id ?? j.app_id);
  const apiHash = String(j.api_hash ?? j.app_hash ?? "").trim();
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error("session json is missing api_id/api_hash");
  }
  return {
    phone: String(j.phone ?? "").trim(),
    apiId,
    apiHash,
    twoFa: String(j.twofa ?? j.password ?? "").trim(),
    deviceModel: j.device_model ? String(j.device_model) : undefined,
    systemVersion: j.system_version ? String(j.system_version) : undefined,
    appVersion: j.app_version ? String(j.app_version) : undefined,
    systemLangCode: j.system_lang_code ? String(j.system_lang_code) : undefined,
    langPack: j.lang_pack ? String(j.lang_pack) : undefined,
    uuid: j.uuid ? String(j.uuid) : j.id ? String(j.id) : undefined,
  };
}

/**
 * Re-encode a Telethon .session (a SQLite file) into a GramJS StringSession. The two store
 * the same auth key; only the container differs. better-sqlite3 needs a path, so the bytes
 * are written to a short-lived temp file and removed immediately after the single read.
 */
export function telethonSessionToStringSession(sessionBytes: Buffer): {
  sessionString: string;
  dcId: number;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bemby-sess-"));
  const file = path.join(dir, `${crypto.randomBytes(8).toString("hex")}.session`);
  try {
    fs.writeFileSync(file, sessionBytes);
    const sdb = new Database(file, { readonly: true });
    let row: {
      dc_id: number;
      server_address: string;
      port: number;
      auth_key: Buffer;
    };
    try {
      row = sdb
        .prepare("SELECT dc_id, server_address, port, auth_key FROM sessions LIMIT 1")
        .get() as typeof row;
    } finally {
      sdb.close();
    }
    if (!row || !row.auth_key || row.auth_key.length !== 256) {
      throw new Error("session file has no usable auth key");
    }
    const addr = Buffer.from(row.server_address, "utf8");
    const addrLen = Buffer.alloc(2);
    addrLen.writeInt16BE(addr.length);
    const port = Buffer.alloc(2);
    port.writeInt16BE(row.port);
    const packed = Buffer.concat([
      Buffer.from([row.dc_id]),
      addrLen,
      addr,
      port,
      Buffer.from(row.auth_key),
    ]);
    // GramJS's StringSession is version byte "1" + base64 of the packed layout.
    return { sessionString: "1" + packed.toString("base64"), dcId: row.dc_id };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Unpack a converted archive into per-account credentials, keyed by phone. Accounts whose
 * .session or .json is missing or unreadable are reported in `errors` rather than dropped
 * silently, so a partly-bad batch still surfaces which cards failed.
 */
export function parseConvertedArchive(zip: Buffer): {
  accounts: ConvertedAccount[];
  errors: { phone: string; error: string }[];
} {
  const { files } = readZip(zip, ZIP_LIMITS);
  // Group entries by their phone stem (<phone>.session / .json / .passkey).
  const byStem = new Map<string, { session?: Buffer; json?: Buffer }>();
  for (const f of files) {
    const name = baseName(f.name);
    const dot = name.lastIndexOf(".");
    if (dot < 0) continue;
    const stem = name.slice(0, dot);
    const ext = name.slice(dot + 1).toLowerCase();
    const entry = byStem.get(stem) ?? {};
    if (ext === "session") entry.session = f.data;
    else if (ext === "json") entry.json = f.data;
    byStem.set(stem, entry);
  }

  const accounts: ConvertedAccount[] = [];
  const errors: { phone: string; error: string }[] = [];
  for (const [stem, entry] of byStem) {
    try {
      if (!entry.json) throw new Error("missing .json in archive");
      if (!entry.session) throw new Error("missing .session in archive");
      const meta = parseJsonMeta(entry.json);
      const { sessionString, dcId } = telethonSessionToStringSession(entry.session);
      accounts.push({
        phone: meta.phone || stem,
        sessionString,
        dcId,
        meta,
      });
    } catch (err: any) {
      errors.push({ phone: stem, error: err?.message ?? String(err) });
    }
  }
  return { accounts, errors };
}
