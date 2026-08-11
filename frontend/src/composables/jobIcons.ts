import { ref } from "vue";
import { jobIconsApi, type JobIcon } from "../api/client";

// Custom icons are fetched once and shared: every job row in a list would otherwise ask
// for the same handful of images. The built-in names below need no fetching at all -- they
// are icon-font classes the panel already loads.

export const CUSTOM_PREFIX = "custom:";

/** The icon a job falls back to when it has none, or names one that has been deleted. */
export const DEFAULT_JOB_ICON = "fa-solid fa-clipboard-check";

/**
 * The built-in choices, grouped so the picker is scannable rather than a wall of glyphs.
 * Every one of these ships with the Font Awesome build the panel already loads.
 */
export const BUILT_IN_JOB_ICONS: Array<{ group: string; icons: string[] }> = [
  {
    group: "common",
    icons: [
      "fa-solid fa-clipboard-check",
      "fa-solid fa-calendar-check",
      "fa-solid fa-circle-check",
      "fa-solid fa-bolt",
      "fa-solid fa-clock",
      "fa-solid fa-rotate",
      "fa-solid fa-star",
      "fa-solid fa-heart",
    ],
  },
  {
    group: "rewards",
    icons: [
      "fa-solid fa-gift",
      "fa-solid fa-coins",
      "fa-solid fa-sack-dollar",
      "fa-solid fa-ticket",
      "fa-solid fa-trophy",
      "fa-solid fa-crown",
      "fa-solid fa-gem",
      "fa-solid fa-dice",
    ],
  },
  {
    group: "media",
    icons: [
      "fa-solid fa-film",
      "fa-solid fa-tv",
      "fa-solid fa-music",
      "fa-solid fa-play",
      "fa-solid fa-video",
      "fa-solid fa-headphones",
      "fa-solid fa-photo-film",
      "fa-solid fa-compact-disc",
    ],
  },
  {
    group: "infra",
    icons: [
      "fa-solid fa-server",
      "fa-solid fa-cloud",
      "fa-solid fa-network-wired",
      "fa-solid fa-database",
      "fa-solid fa-shield-halved",
      "fa-solid fa-key",
      "fa-solid fa-globe",
      "fa-solid fa-robot",
    ],
  },
  {
    group: "misc",
    icons: [
      "fa-solid fa-paper-plane",
      "fa-solid fa-envelope",
      "fa-solid fa-cart-shopping",
      "fa-solid fa-flask",
      "fa-solid fa-fire",
      "fa-solid fa-leaf",
      "fa-solid fa-mug-hot",
      "fa-solid fa-flag",
    ],
  },
];

const customIcons = ref<JobIcon[]>([]);
const iconDir = ref("");
const loaded = ref(false);
let inFlight: Promise<void> | null = null;

/** Fetches the custom icons once; concurrent callers share the one request. */
export async function loadJobIcons(force = false): Promise<void> {
  if (loaded.value && !force) return;
  if (inFlight && !force) return inFlight;
  inFlight = jobIconsApi
    .list()
    .then((res) => {
      customIcons.value = res.icons;
      iconDir.value = res.dir;
      loaded.value = true;
    })
    .catch(() => {
      // A list that cannot be fetched leaves jobs on the default glyph, which is a
      // better outcome than a broken panel
      customIcons.value = [];
      loaded.value = true;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export async function uploadJobIcon(file: File): Promise<JobIcon> {
  const icon = await jobIconsApi.upload(file);
  const existing = customIcons.value.findIndex((i) => i.name === icon.name);
  if (existing === -1) customIcons.value.push(icon);
  else customIcons.value[existing] = icon;
  return icon;
}

export async function removeJobIcon(name: string): Promise<void> {
  await jobIconsApi.remove(name);
  customIcons.value = customIcons.value.filter((i) => i.name !== name);
}

/** The data URL behind a "custom:" reference, or null when that file is gone. */
export function customIconUrl(icon: string | null | undefined): string | null {
  if (!icon?.startsWith(CUSTOM_PREFIX)) return null;
  const name = icon.slice(CUSTOM_PREFIX.length);
  return customIcons.value.find((i) => i.name === name)?.dataUrl ?? null;
}

export function isCustomIcon(icon: string | null | undefined): boolean {
  return Boolean(icon?.startsWith(CUSTOM_PREFIX));
}

export { customIcons, iconDir, loaded as jobIconsLoaded };
