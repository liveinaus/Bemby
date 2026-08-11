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

/** What the lockdown managed: how much is hidden outright, and what would not go that far. */
function privacyText(data: Record<string, any>): string {
  const parts = [
    t("accounts.bulkPrivacy.result.hidden").replace("{n}", String(data.nobody ?? 0)),
  ];
  const contacts = Array.isArray(data.contacts) ? data.contacts : [];
  if (contacts.length) {
    parts.push(
      t("accounts.bulkPrivacy.result.contacts").replace(
        "{keys}",
        contacts.map((key: string) => t(`accounts.bulkPrivacy.key.${key}`)).join("、"),
      ),
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
    case "login-email":
      return String(data.email ?? item.message);
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
    default:
      return item.message;
  }
}
