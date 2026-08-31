#!/usr/bin/env bash
#
# Vendors Chromium's runtime dependencies into backend/data/chrome-deps.
#
# Dev only. The production image installs these packages itself (see the apt-get block in
# the Dockerfile), and dev.sh skips the prefix when it is absent, so nothing here reaches a
# deployed container.
#
# Why it exists: a dev container that ships without Chrome's system libraries makes every
# CloakBrowser build fail identically with "The browser binary could not be started", which
# reads like a bad download. It is not. Re-downloading the browser cannot fix a missing
# libglib-2.0.so.0, so the packages are fetched here instead.
#
# Needs no root: packages come down with `apt-get download` and are unpacked with
# `dpkg-deb -x` into a prefix that dev.sh puts on LD_LIBRARY_PATH. The prefix lives in the
# data dir, which is a volume, so it survives the container being recreated.
#
# Usage: scripts/dev-browser-deps.sh [--force]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="$SCRIPT_DIR/backend/data/chrome-deps"
ENV_FILE="$PREFIX/env.sh"
WORK="${TMPDIR:-/tmp}/bemby-browser-deps.$$"

# The X server resolves xkbcomp through a path compiled into the binary, with no option or
# environment variable to redirect it. Patching that string is the only way in without root,
# and a patch cannot lengthen it, so the shim directory must fit in the 8 bytes "/usr/bin"
# occupies. Hence a path this short rather than one under the data dir.
XKB_SHIM="${BEMBY_XKB_SHIM:-/git/xkb}"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# ── Preconditions ─────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Linux" ] || { echo "Linux only; nothing to do." >&2; exit 0; }
for tool in apt-get dpkg-deb dpkg-query python3; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done

if [ -f "$ENV_FILE" ] && [ "$FORCE" -eq 0 ]; then
  echo "Browser deps already vendored in $PREFIX"
  echo "Re-run with --force to rebuild."
  exit 0
fi

if [ ${#XKB_SHIM} -gt 8 ]; then
  echo "BEMBY_XKB_SHIM must be at most 8 characters (got '$XKB_SHIM')." >&2
  exit 1
fi

ARCH="$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || echo "$(uname -m)-linux-gnu")"

# ── The package set ───────────────────────────────────────────────────────────
# Chrome's own dependencies plus the headed-mode stack: Xvfb for a display and x11vnc for
# the live job view. Matches the Dockerfile's list, with the names Ubuntu 24.04 renamed
# under the 64-bit time_t transition.
PKGS=(
  libnss3 libnspr4 libdbus-1-3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64
  libdrm2 libatspi2.0-0t64 libx11-6 libxcomposite1 libxdamage1 libxext6
  libxfixes3 libxrandr2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2
  libasound2t64 libxcb1 libexpat1 libglib2.0-0t64 libudev1
  fontconfig fonts-liberation xvfb x11vnc
)

# The browser renders through its own bundled SwiftShader (--use-angle=swiftshader), so the
# Mesa DRI drivers and the LLVM runtime behind them are ~250MB of dead weight. The Dockerfile
# drops them for the same reason.
EXCLUDE='libllvm[0-9]*|libgl1-mesa-dri|mesa-libgallium'

trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/debs" "$WORK/apt/lists/partial" "$WORK/apt/cache/archives/partial"

# A private apt state dir keeps this unprivileged. The container's own package lists are
# usually stale enough that half the archive URLs 404, so they are refreshed here instead.
cat > "$WORK/apt.conf" <<EOF
Dir::State "$WORK/apt";
Dir::State::Lists "$WORK/apt/lists";
Dir::State::status "/var/lib/dpkg/status";
Dir::Cache "$WORK/apt/cache";
Dir::Cache::archives "$WORK/apt/cache/archives";
Dir::Etc::SourceList "/etc/apt/sources.list";
Dir::Etc::SourceParts "/etc/apt/sources.list.d";
Debug::NoLocking "true";
EOF
export APT_CONFIG="$WORK/apt.conf"

echo "Refreshing package lists..."
apt-get update -qq 2>/dev/null || true

# ── Resolve the dependency closure ────────────────────────────────────────────
# apt-cache rejects the whole list when given every package at once, so ask per package.
echo "Resolving dependencies..."
: > "$WORK/raw.txt"
for p in "${PKGS[@]}"; do
  apt-cache depends --recurse --no-recommends --no-suggests \
    --no-conflicts --no-breaks --no-replaces --no-enhances "$p" 2>/dev/null >> "$WORK/raw.txt" || true
done
grep -E '^[a-zA-Z0-9]' "$WORK/raw.txt" | grep -v '<' | sort -u > "$WORK/closure.txt"

# Anything dpkg already has stays where it is. Skipping installed packages is what keeps the
# prefix free of a second libc or libstdc++, so nothing on LD_LIBRARY_PATH can shadow a
# system library that other processes, node included, are already linked against.
: > "$WORK/need.txt"
while read -r p; do
  case "$(dpkg-query -W -f='${Status}' "$p" 2>/dev/null)" in
    *"install ok installed"*) ;;
    *) echo "$p" >> "$WORK/need.txt" ;;
  esac
done < "$WORK/closure.txt"
grep -vxE "$EXCLUDE" "$WORK/need.txt" > "$WORK/download.txt" || true

COUNT=$(wc -l < "$WORK/download.txt")
if [ "$COUNT" -eq 0 ]; then
  echo "Every dependency is already installed system-wide; no prefix needed."
  exit 0
fi

# ── Download and unpack ───────────────────────────────────────────────────────
echo "Downloading $COUNT packages..."
(
  cd "$WORK/debs"
  # In batches, then singly for whatever a batch dropped.
  xargs -a "$WORK/download.txt" -n 20 apt-get download >/dev/null 2>&1 || true
  ls ./*.deb 2>/dev/null | sed 's|.*/||; s|_.*||' | sort -u > "$WORK/got.txt" || : > "$WORK/got.txt"
  comm -23 <(sort -u "$WORK/download.txt") "$WORK/got.txt" | while read -r p; do
    apt-get download "$p" >/dev/null 2>&1 || echo "  could not download $p" >&2
  done
)

echo "Unpacking into $PREFIX..."
rm -rf "$PREFIX"
mkdir -p "$PREFIX"
for d in "$WORK"/debs/*.deb; do
  dpkg-deb -x "$d" "$PREFIX" || echo "  could not unpack $(basename "$d")" >&2
done

# ── Xvfb's compiled-in paths ──────────────────────────────────────────────────
# Both strings are replaced in place with shorter ones, so the binary's layout is untouched.
if [ -x "$PREFIX/usr/bin/Xvfb" ]; then
  echo "Redirecting Xvfb's xkb paths to $XKB_SHIM..."
  mkdir -p "$XKB_SHIM"
  ln -sfn "$PREFIX/usr/bin/xkbcomp" "$XKB_SHIM/xkbcomp"
  ln -sfn "$PREFIX/usr/share/X11/xkb" "$XKB_SHIM/data"
  cat > "$XKB_SHIM/README" <<EOF
Created by Bemby's scripts/dev-browser-deps.sh.

Xvfb resolves xkbcomp and its keymap data through paths compiled into the binary. The
vendored copy in backend/data/chrome-deps is patched to look here instead, because the
replacement path cannot be longer than the "/usr/bin" it overwrites. Safe to delete once
that copy is gone.
EOF
  python3 - "$PREFIX/usr/bin/Xvfb" "$XKB_SHIM" <<'PY'
import sys

path, shim = sys.argv[1], sys.argv[2]
blob = bytearray(open(path, "rb").read())

def patch(old, new):
    o, n = old.encode() + b"\0", new.encode() + b"\0"
    if len(n) > len(o):
        sys.exit(f"replacement '{new}' does not fit in '{old}'")
    i = blob.find(o)
    if i < 0:
        print(f"  {old}: not found (already patched?)")
        return
    if blob.find(o, i + 1) >= 0:
        sys.exit(f"'{old}' appears more than once; refusing to patch")
    blob[i:i + len(o)] = n.ljust(len(o), b"\0")
    print(f"  {old} -> {new}")

patch("/usr/bin", shim)
patch("/usr/share/X11/xkb", f"{shim}/data")
open(path, "wb").write(blob)
PY
fi

# ── Fonts ─────────────────────────────────────────────────────────────────────
# A browser with almost no fonts measures text like nothing else on the web, which is the
# sort of thing a challenge scores against, and the container ships with eight faces.
#
# The vendored ones are reached through the "xdg" dir in /etc/fonts/fonts.conf, which is the
# one hook left: cfFonts.ts points FONTCONFIG_FILE at a config of its own for the CJK and
# emoji install, and that config includes the system one, so a directory added here is seen
# by both. That entry resolves under XDG_DATA_HOME, so the prefix carries its own rather than
# writing into a home directory: dev.sh may run as a different user than this script did.
if [ -d "$PREFIX/usr/share/fonts" ]; then
  mkdir -p "$PREFIX/xdg/fonts"
  ln -sfn "$PREFIX/usr/share/fonts" "$PREFIX/xdg/fonts/vendored"
  LD_LIBRARY_PATH="$PREFIX/usr/lib/$ARCH:$PREFIX/lib/$ARCH:$PREFIX/usr/lib" \
    XDG_DATA_HOME="$PREFIX/xdg" \
    "$PREFIX/usr/bin/fc-cache" -f >/dev/null 2>&1 || true
fi

# ── The environment dev.sh sources ────────────────────────────────────────────
cat > "$ENV_FILE" <<EOF
# Generated by scripts/dev-browser-deps.sh. Sourced by dev.sh; do not edit by hand.
#
# LD_LIBRARY_PATH is safe to set process-wide here: the prefix only ever holds packages the
# system does not have, so none of it shadows a library node or anything else already links
# against. PATH is appended rather than prepended for the same reason, leaving system
# binaries in charge and adding only Xvfb, x11vnc and their helpers. XDG_DATA_HOME is what
# puts the vendored fonts in front of fontconfig whichever user started dev.sh.
BEMBY_BROWSER_PREFIX="$PREFIX"
export LD_LIBRARY_PATH="$PREFIX/usr/lib/$ARCH:$PREFIX/lib/$ARCH:$PREFIX/usr/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
export PATH="\$PATH:$PREFIX/usr/bin"
export XDG_DATA_HOME="$PREFIX/xdg"
EOF

echo ""
echo "Done. $(du -sh "$PREFIX" | cut -f1) in $PREFIX"
echo "dev.sh picks it up automatically on the next start."
