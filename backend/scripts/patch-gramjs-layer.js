#!/usr/bin/env node
"use strict";

// GramJS ships TL layer 198, which predates channel direct messages ("monoforums", layer 204):
// on a 198 connection the server never sends channel.linked_monoforum_id, so there is no way to
// find the hidden supergroup a private message to a channel goes to.
//
// Raising the layer for a single call does not work. Telegram refuses a bare invokeWithLayer
// with CONNECTION_LAYER_INVALID, accepts it when paired with initConnection, and then keeps the
// new layer for the whole *session* -- not just that connection -- so every other connection on
// the account starts receiving constructors GramJS cannot read. The layer is all-or-nothing per
// account, so the client has to speak one layer throughout.
//
// Hence this: GramJS builds its Api namespace at runtime by parsing a plain-text TL schema, so
// moving layers is a schema swap rather than a rewrite. It replaces the vendored schema, has
// GramJS regenerate its modules and typings from it, and bumps the LAYER constant to match.
//
// Idempotent, and safe to run when the patch is already applied. If it cannot complete it leaves
// GramJS untouched: the app then runs on stock 198, where direct messages are simply unavailable.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const LAYER = 225;
const VENDORED_TL = path.resolve(__dirname, "../vendor/telegram-api-layer225.tl");
const TL_DIR = path.resolve(__dirname, "../node_modules/telegram/tl");

const say = (msg) => console.log(`[gramjs-layer] ${msg}`);

function main() {
  if (!fs.existsSync(TL_DIR)) {
    say("telegram package not installed -- nothing to patch");
    return;
  }
  if (!fs.existsSync(VENDORED_TL)) {
    say(`vendored schema missing at ${VENDORED_TL} -- leaving GramJS on its stock layer`);
    return;
  }

  const allTlPath = path.join(TL_DIR, "AllTLObjects.js");
  const current = fs.readFileSync(allTlPath, "utf-8");
  const found = current.match(/exports\.LAYER = (\d+);/);
  if (!found) {
    say("could not find the LAYER constant -- leaving GramJS on its stock layer");
    return;
  }
  if (Number(found[1]) === LAYER) {
    say(`already on layer ${LAYER}`);
    return;
  }

  const staticDir = path.join(TL_DIR, "static");
  fs.mkdirSync(staticDir, { recursive: true });

  // The MTProto schema is layer-independent and ships only as a generated module, so it is
  // recovered from there. It has to be written before the generator runs, which reads it back.
  const schemaPath = path.join(staticDir, "schema.tl");
  if (!fs.existsSync(schemaPath)) {
    fs.writeFileSync(schemaPath, require(path.join(TL_DIR, "schemaTl.js")));
  }
  fs.copyFileSync(VENDORED_TL, path.join(staticDir, "api.tl"));

  // Rewrites apiTl.js and schemaTl.js, and api.d.ts as a side effect of the generator it loads
  execFileSync(process.execPath, [path.join(TL_DIR, "generateModule.js")], {
    cwd: TL_DIR,
    stdio: "inherit",
  });

  patchLayer(allTlPath, /exports\.LAYER = \d+;/, `exports.LAYER = ${LAYER};`);
  patchLayer(
    path.join(TL_DIR, "AllTLObjects.d.ts"),
    /export declare const LAYER = \d+;/,
    `export declare const LAYER = ${LAYER};`,
  );

  say(`patched from layer ${found[1]} to ${LAYER}`);
}

function patchLayer(file, pattern, replacement) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf-8");
  if (!pattern.test(text)) return;
  fs.writeFileSync(file, text.replace(pattern, replacement));
}

main();
