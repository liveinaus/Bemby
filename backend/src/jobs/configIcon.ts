import { isKnownIcon } from "./jobIcons";

// The icon rides inside the config JSON that jobs and templates already carry, so the panel
// gained icons without a schema change. Two consequences are handled here rather than in
// every route: the icon is presented as its own API field, and a config edit that knows
// nothing about icons must not drop it.

const ICON_KEY = "icon";

function parseConfig(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    // Some rows were written with the object double-encoded
    let parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The icon a stored config row carries, or null. */
export function iconFromConfig(raw: string | null | undefined): string | null {
  const value = parseConfig(raw)[ICON_KEY];
  return typeof value === "string" && value ? value : null;
}

/** The config a client sent, with the icon key taken out -- it is set through `icon`. */
export function stripIcon(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const { [ICON_KEY]: _dropped, ...rest } = config as Record<string, unknown>;
  return rest;
}

/**
 * The config JSON to store, given what the client sent and what is already there.
 *
 * `icon` undefined means the request said nothing about icons, so the stored one is kept:
 * that is what stops the job form, which does not know about icons, from clearing one every
 * time it saves. `icon` null clears it deliberately.
 */
export function mergeIconIntoConfig(
  nextConfig: unknown,
  existingRaw: string | null | undefined,
  icon: string | null | undefined,
): string | null {
  const base =
    nextConfig === undefined
      ? parseConfig(existingRaw)
      : ((stripIcon(nextConfig) as Record<string, unknown>) ?? {});

  const resolved =
    icon === undefined ? iconFromConfig(existingRaw) : icon ? icon : null;

  const merged: Record<string, unknown> =
    base && typeof base === "object" ? { ...base } : {};
  if (resolved && isKnownIcon(resolved)) {
    merged[ICON_KEY] = resolved;
  } else {
    delete merged[ICON_KEY];
  }

  return Object.keys(merged).length ? JSON.stringify(merged) : null;
}
