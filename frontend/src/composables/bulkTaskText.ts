import { t } from "../i18n";
import type { BulkTask, BulkTaskItem, BulkTaskKind } from "../api/client";

// Renders a background task's per-item outcome in the operator's language. The
// server sends a machine-readable `data` bag alongside its English message, so
// results keep the same wording the in-page versions used to produce.

export function bulkTaskTitle(kind: BulkTaskKind): string {
  return t(`bulkTasks.kind.${kind}`);
}

function cleanText(data: Record<string, any>): string {
  let msg = t("tgc.clean.toastResult")
    .replace("{left}", String(data.left ?? 0))
    .replace("{deleted}", String(data.deleted ?? 0))
    .replace("{contacts}", String(data.contacts ?? 0))
    .replace("{folders}", String(data.folders ?? 0));
  const failed = Array.isArray(data.failed) ? data.failed.length : 0;
  if (failed) {
    msg += `, ${t("tgc.clean.toastFailedPart").replace("{n}", String(failed))}`;
  }
  return msg;
}

function credentialsText(data: Record<string, any>): string {
  const parts: string[] = [];
  if (data.twoFaChanged) parts.push(t("accounts.bulkCred.result.twoFaChanged"));
  if (data.devicesRemoved)
    parts.push(t("accounts.bulkCred.result.devicesRemoved"));
  if (typeof data.passkeysRemoved === "number") {
    parts.push(
      t("accounts.bulkCred.result.passkeysRemoved").replace(
        "{n}",
        String(data.passkeysRemoved),
      ),
    );
  }
  if (data.passkeyReadded)
    parts.push(t("accounts.bulkCred.result.passkeyReadded"));
  if (data.notesUpdated) parts.push(t("accounts.bulkCred.result.notesUpdated"));
  return parts.join(", ");
}

/** Where each key ended up: hidden outright, narrowed to contacts, opened, or refused. */
function privacyText(data: Record<string, any>): string {
  const keyNames = (keys: string[]) =>
    keys.map((key) => t(`accounts.bulkPrivacy.key.${key}`)).join("、");
  const parts: string[] = [];
  if (data.nobody) {
    parts.push(
      t("accounts.bulkPrivacy.result.hidden").replace("{n}", String(data.nobody)),
    );
  }
  const contacts = Array.isArray(data.contacts) ? data.contacts : [];
  if (contacts.length) {
    parts.push(
      t("accounts.bulkPrivacy.result.contacts").replace("{keys}", keyNames(contacts)),
    );
  }
  const everybody = Array.isArray(data.everybody) ? data.everybody : [];
  if (everybody.length) {
    parts.push(
      t("accounts.bulkPrivacy.result.everybody").replace("{keys}", keyNames(everybody)),
    );
  }
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  if (skipped.length) {
    parts.push(
      t("accounts.bulkPrivacy.result.skipped").replace(
        "{keys}",
        skipped
          .map((s: { key: string }) => t(`accounts.bulkPrivacy.key.${s.key}`))
          .join("、"),
      ),
    );
  }
  return parts.join(", ");
}

/** What one account's read found, and where it went. */
function extractText(data: Record<string, any>): string {
  const parts = [
    t("accounts.bulkExtract.resultSummary")
      .replace("{matched}", String(data.matched ?? 0))
      .replace("{scanned}", String(data.scanned ?? 0))
      .replace("{lines}", String(data.lines ?? 0)),
  ];
  if (data.stored) {
    parts.push(
      t("accounts.bulkExtract.resultStored").replace("{n}", String(data.stored)),
    );
  }
  if (data.truncated) parts.push(t("accounts.bulkExtract.resultTruncated"));
  return parts.join(", ");
}

/** Localised outcome for a finished item; falls back to the server's own message. */
export function bulkTaskItemText(task: BulkTask, item: BulkTaskItem): string {
  if (item.status !== "done" || !item.data) return item.message;
  const data = item.data;
  switch (task.kind) {
    case "spam-check": {
      const status = String(data.spamStatus ?? "unknown");
      const label = t(`accounts.spam.${status}`);
      return item.message ? `${label} — ${item.message}` : label;
    }
    case "fetch-attributes": {
      const warnings = Array.isArray(data.warnings) ? data.warnings : [];
      return warnings.length
        ? warnings.join("; ")
        : t("accounts.bulkFetch.doneMsg");
    }
    case "login-email": {
      // The exit is shown alongside the address: several accounts on one exit is why Telegram
      // stops sending the codes partway through a run.
      const email = String(data.email ?? item.message);
      return data.exit ? `${email} (${data.exit})` : email;
    }
    case "credentials":
      return credentialsText(data);
    case "passkey":
      return data.action === "skippedValid"
        ? t("accounts.bulkPasskey.result.skippedValid")
        : t("accounts.bulkPasskey.result.added");
    case "privacy":
      return privacyText(data);
    case "clean":
      return cleanText(data);
    case "extract-messages":
      return extractText(data);
    default:
      return item.message;
  }
}
