import { ref } from "vue";
import { settingsApi } from "../api/client";

// Module-level singletons: which shortcut buttons a log row carries. All three are off by
// default, so the row stays as narrow as it was for anyone who has not asked for them.
// Shared so a change in Settings shows on the logs page without a reload.
const messenger = ref(false);
const jobEdit = ref(false);
const templateEdit = ref(false);
let loaded = false;

/** Lazy-loads the three settings once. Safe to call from any view's onMounted. */
export async function loadLogRowButtonSettings(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const s = await settingsApi.get();
    messenger.value = s.logs_messenger_button === "true";
    jobEdit.value = s.logs_job_edit_button === "true";
    templateEdit.value = s.logs_template_edit_button === "true";
  } catch {
    loaded = false; // allow a later retry
  }
}

/** Applies a change straight away (called by Settings when a toggle flips). */
export function setLogRowButtons(values: {
  messenger?: boolean;
  jobEdit?: boolean;
  templateEdit?: boolean;
}): void {
  if (values.messenger !== undefined) messenger.value = values.messenger;
  if (values.jobEdit !== undefined) jobEdit.value = values.jobEdit;
  if (values.templateEdit !== undefined) templateEdit.value = values.templateEdit;
  loaded = true;
}

export {
  messenger as logsMessengerButton,
  jobEdit as logsJobEditButton,
  templateEdit as logsTemplateEditButton,
};
