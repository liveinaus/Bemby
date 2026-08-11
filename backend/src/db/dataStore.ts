import { db } from "./database";

// The data store: folders holding named records, which a job reads as `{data.folder.key}`
// and writes with the data steps. What it is for is the value that has to outlive one run --
// the account a signup just created, the address a site handed out -- where a job variable
// (`web_set`) is gone the moment the run ends.
//
// A record's value is any JSON: an object, or a bare string or number. It is stored as JSON
// text so the type survives a round trip, and a `path` reaches inside an object, which is
// what lets `{data.example.email.password}` mean one field rather than the whole record.
//
// Values are stored as they are typed. Nothing here is encrypted at rest, so a password kept
// in the store is a password in the database file: the secrets table is the place for one
// that only the backend should ever see.

/**
 * Folder names and record keys may hold anything but a brace or a bracket, which are what a
 * reference is written with. A key holding a dot -- an email address, the obvious thing to
 * key a signup's record by -- is fine: it is written in the bracket form,
 * `{data.example[me@example.com].password}`, since the dotted form splits on dots.
 */
export const DATA_NAME_PATTERN = /^[^[\]{}]{1,128}$/;

/** How deep a path may reach into a value, so a malformed reference cannot walk forever. */
const MAX_PATH_DEPTH = 12;

/**
 * A whole reference as it is written inside `{...}`: `data`, then a segment per level, each
 * either `.name` or `[name]`. Used to find them in a template and to read one apart.
 */
export const DATA_REF_PATTERN = /\{data((?:\.[^.[\]{}]+|\[[^[\]{}]+\])+)\}/g;

export type DataFolder = {
  id: number;
  name: string;
  recordCount: number;
  updatedAt: string | null;
  /** Line format this folder's text export was last written with, if it has one. */
  exportFormat?: string;
};

export type DataRecord = {
  id: number;
  folderId: number;
  key: string;
  /** The value itself, parsed: an object, an array, a string, a number, a boolean or null. */
  value: unknown;
  updatedAt: string | null;
};

type FolderRow = { id: number; name: string; updated_at: string | null };
type RecordRow = {
  id: number;
  folder_id: number;
  key: string;
  value: string;
  updated_at: string | null;
};

export function isValidDataName(name: string): boolean {
  // Trailing space in a name that is otherwise fine is a typo every time, and an invisible one
  return DATA_NAME_PATTERN.test(name) && name === name.trim();
}

/**
 * The reference a job writes to reach this record: the dotted form where every name allows it,
 * and the bracket form for a name holding a dot. Shared by the log lines and the panel's
 * "copy reference", so what is offered is always what the parser reads back.
 */
export function dataRefText(folder: string, key: string, path = ""): string {
  const segment = (name: string) => (name.includes(".") ? `[${name}]` : `.${name}`);
  const tail = path.trim() ? `.${path.trim().replace(/^\.+/, "")}` : "";
  return `{data${segment(folder)}${segment(key)}${tail}}`;
}

/**
 * Whether this deployment offers the data store at all, set by DATA_MANAGEMENT ("1"/"true")
 * the way bulk account management is set by BULK_ACCOUNT_MANAGEMENT. Off is off for everyone:
 * no menu entry, no Settings toggle, no data steps in the step editor and no API behind them,
 * whatever the stored setting says. For a panel that has no use for the feature and is simpler
 * without it.
 */
export function isDataManagementEnabled(): boolean {
  const v = (process.env.DATA_MANAGEMENT ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Why the store is unavailable, naming the switch that would change it -- the deployment's env
 * var or the Settings toggle. A step that fails should say which one to go and look at.
 */
export function dataStoreOffReason(): string {
  return isDataManagementEnabled()
    ? "Data is turned off in Settings"
    : "Data is not enabled on this server (set DATA_MANAGEMENT=1)";
}

/**
 * Whether the feature is switched on: offered by the deployment, and on in Settings. Off means
 * jobs cannot read or write it.
 */
export function isDataStoreEnabled(): boolean {
  if (!isDataManagementEnabled()) return false;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'data_store_enabled'")
      .get() as { value: string } | undefined;
    return row?.value === "true";
  } catch {
    return false;
  }
}

/**
 * What the panel typed into a value field, as the value to store: JSON when it reads as JSON,
 * and the text itself when it does not. So `{"a":1}` is an object, `42` a number, and
 * `hunter2` the string it looks like.
 */
export function parseDataValue(input: string): unknown {
  const text = input ?? "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

/** A stored value as a job sees it: a string stays itself, anything else becomes JSON. */
export function dataValueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function parseStored(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/**
 * Splits a path or a reference tail into its segments. Both forms are read: `a.b.c` splits on
 * dots, and `[a.b]` is one segment whatever it holds -- which is how a name carrying a dot is
 * reached, in a path as much as in a reference.
 */
export function splitDataPath(path: string): string[] {
  const parts: string[] = [];
  const text = path ?? "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "[") {
      const end = text.indexOf("]", i + 1);
      if (end === -1) throw new Error(`\`${text}\` has a \`[\` with no closing \`]\``);
      const name = text.slice(i + 1, end);
      if (name) parts.push(name);
      i = end + 1;
      // A dot straight after a bracket is the separator, not an empty segment
      if (text[i] === ".") i++;
      continue;
    }
    let end = i;
    while (end < text.length && text[end] !== "." && text[end] !== "[") end++;
    const name = text.slice(i, end).trim();
    if (name) parts.push(name);
    i = text[end] === "." ? end + 1 : end;
  }
  if (parts.length > MAX_PATH_DEPTH) {
    throw new Error(`a data path may not go more than ${MAX_PATH_DEPTH} levels deep`);
  }
  return parts;
}

/** Walks into a value; a numeric segment indexes an array. Undefined when it leads nowhere. */
export function valueAtPath(value: unknown, path: string[]): unknown {
  let here: unknown = value;
  for (const segment of path) {
    if (here === null || here === undefined) return undefined;
    if (Array.isArray(here)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      here = here[index];
      continue;
    }
    if (typeof here !== "object") return undefined;
    here = (here as Record<string, unknown>)[segment];
  }
  return here;
}

/**
 * Returns the value with `path` set, creating the objects along the way. The original is not
 * touched: a write that fails half-way would otherwise leave the record inconsistent.
 *
 * A segment landing on something that is not a container replaces it with one -- setting
 * `login.password` on a record holding a bare string is a change of shape the user asked for.
 */
export function setValueAtPath(value: unknown, path: string[], next: unknown): unknown {
  if (!path.length) return next;
  const [head, ...rest] = path;

  if (Array.isArray(value)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`\`${head}\` is not an index into a list`);
    }
    const copy = value.slice();
    copy[index] = setValueAtPath(copy[index], rest, next);
    return copy;
  }

  const base =
    value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
  base[head] = setValueAtPath(base[head], rest, next);
  return base;
}

/** Returns the value with `path` removed, and whether there was anything there to remove. */
export function deleteValueAtPath(
  value: unknown,
  path: string[],
): { value: unknown; removed: boolean } {
  if (!path.length) return { value: undefined, removed: true };
  const [head, ...rest] = path;

  if (Array.isArray(value)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) {
      return { value, removed: false };
    }
    const copy = value.slice();
    if (!rest.length) {
      copy.splice(index, 1);
      return { value: copy, removed: true };
    }
    const inner = deleteValueAtPath(copy[index], rest);
    copy[index] = inner.value;
    return { value: copy, removed: inner.removed };
  }

  if (!value || typeof value !== "object") return { value, removed: false };
  const copy = { ...(value as Record<string, unknown>) };
  if (!Object.prototype.hasOwnProperty.call(copy, head)) return { value, removed: false };
  if (!rest.length) {
    delete copy[head];
    return { value: copy, removed: true };
  }
  const inner = deleteValueAtPath(copy[head], rest);
  copy[head] = inner.value;
  return { value: copy, removed: inner.removed };
}

// ── Folders ───────────────────────────────────────────────────────────────────

export function listFolders(): DataFolder[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.name, f.updated_at,
              (SELECT COUNT(*) FROM data_records r WHERE r.folder_id = f.id) AS record_count
         FROM data_folders f
        ORDER BY f.name`,
    )
    .all() as Array<FolderRow & { record_count: number }>;
  const formats = readExportFormats();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    recordCount: r.record_count,
    updatedAt: r.updated_at,
    ...(formats[r.name] ? { exportFormat: formats[r.name] } : {}),
  }));
}

export function findFolderByName(name: string): { id: number; name: string } | null {
  const row = db.prepare("SELECT id, name FROM data_folders WHERE name = ?").get(name) as
    | FolderRow
    | undefined;
  return row ? { id: row.id, name: row.name } : null;
}

export function createFolder(name: string): number {
  return db
    .prepare("INSERT INTO data_folders (name) VALUES (?)")
    .run(name).lastInsertRowid as number;
}

export function renameFolder(id: number, name: string): boolean {
  const before = (
    db.prepare("SELECT name FROM data_folders WHERE id = ?").get(id) as FolderRow | undefined
  )?.name;
  const renamed =
    db
      .prepare(
        "UPDATE data_folders SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
      .run(name, id).changes > 0;
  // The text export format is kept under the folder's name, so it moves with it
  if (renamed && before) moveExportFormat(before, name);
  return renamed;
}

export function deleteFolder(id: number): boolean {
  const name = (
    db.prepare("SELECT name FROM data_folders WHERE id = ?").get(id) as FolderRow | undefined
  )?.name;
  const deleted = db.prepare("DELETE FROM data_folders WHERE id = ?").run(id).changes > 0;
  // Nothing left to export, so the format it was exported with goes too
  if (deleted && name) dropExportFormat(name);
  return deleted;
}

/** The folder of that name, made if it is not there yet. Used by a job's save step. */
function folderIdForWrite(name: string): number {
  const existing = findFolderByName(name);
  if (existing) return existing.id;
  return createFolder(name);
}

// ── Records ───────────────────────────────────────────────────────────────────

function toRecord(row: RecordRow): DataRecord {
  return {
    id: row.id,
    folderId: row.folder_id,
    key: row.key,
    value: parseStored(row.value),
    updatedAt: row.updated_at,
  };
}

export function listRecords(folderId: number): DataRecord[] {
  const rows = db
    .prepare("SELECT * FROM data_records WHERE folder_id = ? ORDER BY key")
    .all(folderId) as RecordRow[];
  return rows.map(toRecord);
}

export function getRecordById(id: number): DataRecord | null {
  const row = db.prepare("SELECT * FROM data_records WHERE id = ?").get(id) as
    | RecordRow
    | undefined;
  return row ? toRecord(row) : null;
}

/**
 * The record sitting at `index` in a folder, oldest first, for a job working through one as a
 * queue: the run takes number 0, deletes it once it is done with it, and the next run finds
 * what had been number 1 in its place.
 *
 * Insertion order rather than the panel's alphabetical listing, so a record added part-way
 * goes to the back of the queue instead of jumping it.
 */
export function recordAt(folderName: string, index: number): DataRecord | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const folder = findFolderByName(folderName);
  if (!folder) return null;
  const row = db
    .prepare("SELECT * FROM data_records WHERE folder_id = ? ORDER BY id LIMIT 1 OFFSET ?")
    .get(folder.id, index) as RecordRow | undefined;
  return row ? toRecord(row) : null;
}

export function getRecord(folderId: number, key: string): DataRecord | null {
  const row = db
    .prepare("SELECT * FROM data_records WHERE folder_id = ? AND key = ?")
    .get(folderId, key) as RecordRow | undefined;
  return row ? toRecord(row) : null;
}

export function createRecord(folderId: number, key: string, value: unknown): number {
  return db
    .prepare("INSERT INTO data_records (folder_id, key, value) VALUES (?, ?, ?)")
    .run(folderId, key, JSON.stringify(value ?? null)).lastInsertRowid as number;
}

export function updateRecord(
  id: number,
  changes: { key?: string; value?: unknown },
): boolean {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (changes.key !== undefined) {
    sets.push("key = ?");
    args.push(changes.key);
  }
  if (changes.value !== undefined) {
    sets.push("value = ?");
    args.push(JSON.stringify(changes.value ?? null));
  }
  if (!sets.length) return false;
  sets.push("updated_at = CURRENT_TIMESTAMP");
  args.push(id);
  return db.prepare(`UPDATE data_records SET ${sets.join(", ")} WHERE id = ?`).run(...args)
    .changes > 0;
}

export function deleteRecord(id: number): boolean {
  return db.prepare("DELETE FROM data_records WHERE id = ?").run(id).changes > 0;
}

/** Writes straight to a record, by folder and key, creating either if it is not there. */
function putRecord(folderId: number, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO data_records (folder_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(folder_id, key) DO UPDATE
         SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).run(folderId, key, JSON.stringify(value ?? null));
}

// ── What a job sees ───────────────────────────────────────────────────────────

/**
 * Reads `folder.key`, `folder.key.path.into.the.value` or the bracket form
 * `folder[me@example.com].password`, as text a step can use. Null when the folder, the record
 * or the path is not there -- which the caller reports rather than quietly sending an empty
 * value.
 */
export function readDataRef(ref: string): string | null {
  const parts = splitDataPath(ref);
  if (parts.length < 2) return null;
  const [folderName, key, ...path] = parts;
  return readDataValue(folderName, key, path);
}

/**
 * The same read, for a caller that already holds the folder, the key and the path apart -- a
 * data step does, and joining them into a reference first would only have to be taken apart
 * again (and would break on a key holding a dot).
 */
export function readDataValue(
  folderName: string,
  key: string,
  path: string | string[] = [],
): string | null {
  const segments = Array.isArray(path) ? path : splitDataPath(path);
  const folder = findFolderByName(folderName);
  if (!folder) return null;
  const record = getRecord(folder.id, key);
  if (!record) return null;
  const value = segments.length ? valueAtPath(record.value, segments) : record.value;
  if (value === undefined) return null;
  return dataValueToText(value);
}

/**
 * Swaps `{data.folder.key}`, `{data.folder.key.path}` and `{data.folder[key].path}` for what
 * is stored, wherever a template is expanded. A reference with nothing behind it is left as it
 * stands, the way an unknown placeholder is: the step that wanted it then fails with the
 * reference still readable, rather than acting on an empty value.
 */
export function fillDataRefs(text: string): string {
  if (!text || !text.includes("{data")) return text;
  if (!isDataStoreEnabled()) return text;
  return text.replace(new RegExp(DATA_REF_PATTERN.source, "g"), (whole, ref: string) => {
    try {
      return readDataRef(ref) ?? whole;
    } catch {
      return whole;
    }
  });
}

/**
 * Stores `value` at `folder`/`key`, into `path` when one is given. The folder and the record
 * are created as needed: a job that has just signed up for something should not have to have
 * had the folder made for it by hand.
 */
export function writeDataValue(
  folderName: string,
  key: string,
  path: string,
  value: unknown,
): void {
  requireName(folderName, "folder name");
  requireName(key, "record key");
  const segments = splitDataPath(path);
  const folderId = folderIdForWrite(folderName);
  if (!segments.length) {
    putRecord(folderId, key, value);
    return;
  }
  const existing = getRecord(folderId, key);
  putRecord(folderId, key, setValueAtPath(existing?.value, segments, value));
}

/**
 * Removes the whole record, or just what `path` points at. Returns false when there was
 * nothing there, so the step can say so rather than reporting a deletion that never happened.
 */
export function deleteDataValue(folderName: string, key: string, path: string): boolean {
  const folder = findFolderByName(folderName);
  if (!folder) return false;
  const record = getRecord(folder.id, key);
  if (!record) return false;
  const segments = splitDataPath(path);
  if (!segments.length) return deleteRecord(record.id);
  const { value, removed } = deleteValueAtPath(record.value, segments);
  if (!removed) return false;
  putRecord(folder.id, key, value);
  return true;
}

function requireName(name: string, what: string): void {
  if (!isValidDataName(name)) {
    throw new Error(
      `${what} "${name}" may not hold a brace or a bracket, or begin or end with a space`,
    );
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export type DataStoreExport = {
  version: "1";
  exportedAt: string;
  folders: Array<{ name: string; records: Array<{ key: string; value: unknown }> }>;
};

/** The whole store, or one folder of it, as the file the Data view downloads. */
export function exportData(folderId?: number): DataStoreExport {
  const folders = listFolders().filter((f) => folderId === undefined || f.id === folderId);
  return {
    version: "1",
    exportedAt: new Date().toISOString(),
    folders: folders.map((f) => ({
      name: f.name,
      records: listRecords(f.id).map((r) => ({ key: r.key, value: r.value })),
    })),
  };
}

// ── Text export ───────────────────────────────────────────────────────────────

// A folder as a plain text file, a line per record, written to a format the person gives:
// `{key}----{password}` for the pair a signup produced, `{key}` alone for a list of addresses.
// The format belongs to the folder and is kept, since a folder exported once is exported again
// the same way.
//
// It lives in the settings table as a map keyed by folder name rather than as a column on the
// folder: the schema is generated outside this repo, and this is bookkeeping of the same kind
// as the other JSON maps kept there. The name is also what the format survives on -- it is how
// a folder is referred to everywhere else, and it outlives the row ids a restored backup mints.

const EXPORT_FORMATS_KEY = "data_export_formats";

/** What a folder with no format of its own is offered: the key and the whole value. */
export const DEFAULT_EXPORT_FORMAT = "{key}----{value}";

function readExportFormats(): Record<string, string> {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(EXPORT_FORMATS_KEY) as { value: string } | undefined;
    const parsed = row?.value ? JSON.parse(row.value) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeExportFormats(map: Record<string, string>): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    EXPORT_FORMATS_KEY,
    JSON.stringify(map),
  );
}

/** The format kept for this folder, or undefined when it has never been exported as text. */
export function getExportFormat(folderName: string): string | undefined {
  const stored = readExportFormats()[folderName];
  return typeof stored === "string" && stored ? stored : undefined;
}

/** Keeps the format for next time. A blank one forgets it, back to the default. */
export function setExportFormat(folderName: string, format: string): void {
  const map = readExportFormats();
  if (format.trim()) map[folderName] = format;
  else delete map[folderName];
  writeExportFormats(map);
}

/** Follows a folder through a rename, so its format is not lost with the old name. */
function moveExportFormat(from: string, to: string): void {
  const map = readExportFormats();
  if (from === to || !map[from]) return;
  map[to] = map[from];
  delete map[from];
  writeExportFormats(map);
}

function dropExportFormat(folderName: string): void {
  const map = readExportFormats();
  if (!(folderName in map)) return;
  delete map[folderName];
  writeExportFormats(map);
}

/**
 * One record as a line of the export.
 *
 * `{key}` is the record's key, `{value}` the whole value as text and `{updatedAt}` its stamp;
 * any other name is a field of the value -- `{password}` for what the signup step saved, and
 * `{a.b}` for a field of a field. A name with nothing behind it comes out empty rather than
 * printed as it stands, since a line of a data file is not the place to find `{password}`; the
 * preview beside the field is what shows a mistyped name for what it is. `\t` and `\n` in the
 * format are the characters they name, so a tab-separated file can be asked for.
 */
export function formatRecordLine(
  format: string,
  record: { key: string; value: unknown; updatedAt?: string | null },
): string {
  const withEscapes = format
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
  return withEscapes.replace(/\{([^{}]+)\}/g, (_whole, name: string) => {
    const token = name.trim();
    if (token === "key") return record.key;
    if (token === "value") return dataValueToText(record.value);
    if (token === "updatedAt") return record.updatedAt ?? "";
    const found = valueAtPath(record.value, splitDataPath(token));
    return found === undefined || found === null ? "" : dataValueToText(found);
  });
}

export type TextExport = { name: string; format: string; text: string; lineCount: number };

/**
 * A folder as the text file it downloads: one line per record, in key order, ending in a
 * newline the way a text file does. `limit` cuts it short for the preview beside the field.
 */
export function exportFolderText(
  folderId: number,
  format: string,
  limit?: number,
): TextExport | null {
  const folder = listFolders().find((f) => f.id === folderId);
  if (!folder) return null;
  const records = listRecords(folderId);
  const shown = limit && limit > 0 ? records.slice(0, limit) : records;
  const lines = shown.map((r) => formatRecordLine(format, r));
  return {
    name: folder.name,
    format,
    text: lines.length ? `${lines.join("\n")}\n` : "",
    lineCount: records.length,
  };
}
