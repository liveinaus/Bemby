import { computed } from "vue";
import type { JobTemplate } from "../api/client";
import { dataStoreEnabled } from "./dataStore";
import { locale } from "../i18n";
import { msApiConfigured } from "./msApi";

// Presets are working chains offered when a new template is being made: the form is filled in
// with one, and whoever is making it reads it over and saves. Nothing is created behind
// anyone's back, and the copy is theirs to edit -- a preset is a starting point, not a managed
// template.
//
// The presets themselves are not in the repository. They name real sites, and a chain is only
// worth having while it still matches the page it drives -- which changes without notice, so a
// stale one shipped to everybody would be worse than none. This file holds the machinery, and
// each installation keeps its own `templatePresets.local.ts` beside it: gitignored, and picked
// up below if it is there. Without one the picker is not shown at all.
//
// That file is therefore backed up by nothing, so `scripts/presets.sh` keeps it in a
// repository of your own next to the checkout and symlinks it in -- `scripts/presets.sh
// status` says where it resolves, `link` puts the symlink back after a `git clean`.

/** A name or a hint, in each language the panel speaks. */
export type PresetText = { zh: string; en: string };

export type TemplatePreset = {
  /** Stable id, used as the option value. */
  id: string;
  /** What it is called in the picker. */
  label: PresetText;
  /** One line on what it does and what it needs. */
  hint: PresetText;
  /** Only offered where the data store is switched on: the chain keeps its result there. */
  requiresDataStore?: boolean;
  /** Only offered where msOauth2api is configured: the chain takes an address from the pool. */
  requiresMsApi?: boolean;
  /** The template as the form reads one, with no id of its own. */
  template: () => JobTemplate;
};

/** A preset's name or hint in whichever language the panel is in. */
export function presetText(text: PresetText): string {
  return text[locale.value] ?? text.en;
}

/**
 * The local preset file, if this installation has one.
 *
 * A glob rather than an import: it answers with nothing when the file is absent, where an
 * import of a missing module would fail the build. Eager, so the presets are in hand at first
 * paint the way they were when they lived here.
 */
const local = import.meta.glob<{ LOCAL_TEMPLATE_PRESETS?: TemplatePreset[] }>(
  "./templatePresets.local.ts",
  { eager: true },
);

export const TEMPLATE_PRESETS: TemplatePreset[] = Object.values(local).flatMap(
  (mod) => mod.LOCAL_TEMPLATE_PRESETS ?? [],
);

/** What the picker offers right now; an empty list means the picker is not shown at all. */
export const availableTemplatePresets = computed(() =>
  TEMPLATE_PRESETS.filter(
    (p) =>
      (!p.requiresDataStore || dataStoreEnabled.value) &&
      (!p.requiresMsApi || msApiConfigured.value),
  ),
);
