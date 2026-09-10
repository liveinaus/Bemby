#!/usr/bin/env node
//
// A budget for what the panel costs to open, checked against a real build.
//
// The views used to be imported into App.vue directly, which put all nine of them, the whole
// help page included, into one 1.6MB chunk every visitor downloaded before seeing anything.
// They are loaded on demand now. Nothing about that is visible in normal use, so a single
// static `import SomeView from './views/SomeView.vue'` would undo it silently -- hence this,
// which fails the moment a view lands back in the entry chunk.
//
// Run after `npm run build`.

import fs from "node:fs";
import path from "node:path";

const ASSETS = path.resolve(import.meta.dirname, "../dist/assets");

/** Kilobytes the first paint may cost: the entry chunk, the shared libraries and the CSS. */
const BUDGET_KB = {
  entry: 420,
  vendor: 200,
  css: 130,
};

/** Views that have to arrive as chunks of their own rather than in the entry. */
const LAZY_VIEWS = [
  "AccountsView",
  "MessengerView",
  "JobsView",
  "SettingsView",
  "LogsView",
  "HelpView",
  "TemplatesView",
  "DataView",
  "ScheduleView",
];

if (!fs.existsSync(ASSETS)) {
  console.error(`No build to check at ${ASSETS}. Run \`npm run build\` first.`);
  process.exit(1);
}

const files = fs.readdirSync(ASSETS);
const kb = (name) => Math.round(fs.statSync(path.join(ASSETS, name)).size / 1024);
const find = (re) => files.filter((f) => re.test(f));

const failures = [];
const report = [];

function budget(label, matches, limit) {
  if (!matches.length) {
    failures.push(`no ${label} chunk in the build`);
    return;
  }
  const size = matches.reduce((n, f) => n + kb(f), 0);
  report.push(`${label.padEnd(8)} ${String(size).padStart(5)} kB  (budget ${limit} kB)`);
  if (size > limit) failures.push(`${label} is ${size}kB, over its ${limit}kB budget`);
}

budget("entry", find(/^index-.*\.js$/), BUDGET_KB.entry);
budget("vendor", find(/^vendor-.*\.js$/), BUDGET_KB.vendor);
budget("css", find(/^index-.*\.css$/), BUDGET_KB.css);

const entry = find(/^index-.*\.js$/)[0];
const entrySource = entry ? fs.readFileSync(path.join(ASSETS, entry), "utf8") : "";
for (const name of LAZY_VIEWS) {
  const own = files.some((f) => f.startsWith(`${name}-`) && f.endsWith(".js"));
  if (!own) failures.push(`${name} has no chunk of its own: it is being imported eagerly`);
}
// A view folded into the entry takes its template strings with it, which is what this looks
// for: a marker no other chunk would carry.
if (entrySource.includes("logs.cf.screenshot"))
  failures.push("LogsView's template is in the entry chunk");

console.log(report.join("\n"));
console.log(`${LAZY_VIEWS.length} views checked for chunks of their own`);

if (failures.length) {
  console.error(`\nBundle budget failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nBundle budget met.");
