import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Browser-driven tests launch the CloakBrowser build in the data dir, which needs Chrome's
// system libraries. In a dev container that ships without them, scripts/dev-browser-deps.sh
// unpacks the packages into data/chrome-deps and writes an env.sh that dev.sh sources. A
// bare `vitest` run does not go through dev.sh, so Chrome used to die on a missing
// libglib-2.0.so.0 and the tests failed for a reason that had nothing to do with them.
//
// env.sh is sourced rather than reimplemented here: it is generated, and restating its
// paths would leave two definitions to drift apart. Chrome is spawned from this process, so
// exporting into process.env is enough for it to inherit them.

const CANDIDATES = [
  path.resolve(process.cwd(), "data/chrome-deps/env.sh"),
  path.resolve(process.cwd(), "backend/data/chrome-deps/env.sh"),
];

const CARRIED = ["BEMBY_BROWSER_PREFIX", "LD_LIBRARY_PATH", "PATH", "XDG_DATA_HOME"];

function loadVendoredBrowserRuntime(): void {
  if (process.env.BEMBY_BROWSER_PREFIX) return; // already in the environment (dev.sh)
  const envFile = CANDIDATES.find((p) => fs.existsSync(p));
  if (!envFile) return; // nothing vendored: a machine with the packages installed

  try {
    const script = `. "${envFile}" >/dev/null 2>&1; printf '%s\\n' ${CARRIED.map((n) => `"$${n}"`).join(" ")}`;
    const lines = execFileSync("bash", ["-c", script], { encoding: "utf8" }).split("\n");
    CARRIED.forEach((name, i) => {
      const value = lines[i]?.trim();
      if (value) process.env[name] = value;
    });
  } catch (e) {
    console.warn("[vitest] vendored browser runtime not loaded:", e);
  }
}

loadVendoredBrowserRuntime();
