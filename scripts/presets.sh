#!/usr/bin/env bash
#
# Keeps this installation's job-template presets in a repository of your own.
#
# The presets are not in Bemby's repository: each chain drives a real site's pages, which
# change without notice, so shipping a stale one to everybody would be worse than shipping
# none. `frontend/src/composables/templatePresets.ts` holds the machinery and picks up
# `templatePresets.local.ts` beside it when it is there.
#
# That leaves the presets with nothing backing them up, which is what this is for. They live
# in a git repository of your own, cloned NEXT TO the Bemby checkout rather than inside it,
# and the file Bemby reads is a symlink into that clone. So:
#
#   - nothing about your presets is in Bemby's history, and no remote of yours is named in it
#   - `git clean -xdf` in Bemby removes the symlink and not the presets; `link` puts it back
#   - `git pull` in Bemby leaves both alone
#
# Usage:
#   scripts/presets.sh init [git-url]   Start: clone your repo (or make one), and link
#   scripts/presets.sh link             Recreate the symlink, e.g. after a git clean
#   scripts/presets.sh pull             Fetch your repo's latest presets
#   scripts/presets.sh push [message]   Commit and push the presets as they stand
#   scripts/presets.sh status           Where the file resolves, and what is uncommitted
#
# The clone lives beside the checkout as ../bemby-presets, or wherever BEMBY_PRESETS_DIR says.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRESETS_DIR="${BEMBY_PRESETS_DIR:-$(dirname "$ROOT")/bemby-presets}"
FILE_NAME="templatePresets.local.ts"
LINK="$ROOT/frontend/src/composables/$FILE_NAME"
SOURCE="$PRESETS_DIR/$FILE_NAME"

die() {
  echo "presets: $1" >&2
  exit 1
}

# Relative, so the pair can be moved or the checkout renamed without the link going stale
link_file() {
  [ -e "$SOURCE" ] || die "no $FILE_NAME in $PRESETS_DIR -- run \`init\` first"
  local target
  target="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' \
    "$SOURCE" "$(dirname "$LINK")")"
  # A real file here is presets that have never been in the repository: kept, not clobbered
  if [ -f "$LINK" ] && [ ! -L "$LINK" ]; then
    die "$LINK is a real file, not a link. Move it into $PRESETS_DIR first, or delete it"
  fi
  ln -sfn "$target" "$LINK"
  echo "presets: $LINK -> $target"
}

case "${1:-status}" in
  init)
    url="${2:-}"
    if [ -d "$PRESETS_DIR/.git" ]; then
      echo "presets: $PRESETS_DIR is already a repository"
    elif [ -n "$url" ]; then
      echo "presets: cloning into $PRESETS_DIR"
      git clone "$url" "$PRESETS_DIR"
    else
      # No URL given: a repository with no remote, ready for one to be added and pushed
      echo "presets: starting a repository in $PRESETS_DIR (add your remote when ready)"
      mkdir -p "$PRESETS_DIR"
      git -C "$PRESETS_DIR" init -q
    fi

    # The presets this checkout already has become the first commit, so nothing is lost by
    # moving to this arrangement
    if [ ! -e "$SOURCE" ] && [ -f "$LINK" ] && [ ! -L "$LINK" ]; then
      echo "presets: moving the presets already here into $PRESETS_DIR"
      mv "$LINK" "$SOURCE"
      git -C "$PRESETS_DIR" add "$FILE_NAME"
      git -C "$PRESETS_DIR" commit -qm "Presets as this installation had them" || true
    fi
    [ -e "$SOURCE" ] || die "nothing to link: put a $FILE_NAME in $PRESETS_DIR"
    link_file
    echo "presets: done. \`git remote add origin <your private repo>\` in $PRESETS_DIR, then \`push\`"
    ;;

  link)
    link_file
    ;;

  pull)
    [ -d "$PRESETS_DIR/.git" ] || die "$PRESETS_DIR is not a repository -- run \`init\` first"
    git -C "$PRESETS_DIR" pull --ff-only
    link_file
    ;;

  push)
    [ -d "$PRESETS_DIR/.git" ] || die "$PRESETS_DIR is not a repository -- run \`init\` first"
    git -C "$PRESETS_DIR" add -A
    if git -C "$PRESETS_DIR" diff --cached --quiet; then
      echo "presets: nothing to commit"
    else
      git -C "$PRESETS_DIR" commit -qm "${2:-Update presets}"
      echo "presets: committed"
    fi
    if git -C "$PRESETS_DIR" remote get-url origin >/dev/null 2>&1; then
      git -C "$PRESETS_DIR" push
    else
      echo "presets: no remote set, so nothing was pushed" >&2
      echo "presets: \`git -C $PRESETS_DIR remote add origin <url>\` then run push again" >&2
    fi
    ;;

  status)
    echo "presets repo:  $PRESETS_DIR"
    if [ -d "$PRESETS_DIR/.git" ]; then
      echo "  remote:      $(git -C "$PRESETS_DIR" remote get-url origin 2>/dev/null || echo '(none set)')"
      echo "  branch:      $(git -C "$PRESETS_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(no commits yet)')"
      if git -C "$PRESETS_DIR" diff --quiet && git -C "$PRESETS_DIR" diff --cached --quiet; then
        echo "  uncommitted: none"
      else
        echo "  uncommitted: yes -- run \`push\`"
      fi
    else
      echo "  (not a repository yet -- run \`init\`)"
    fi
    if [ -L "$LINK" ]; then
      echo "linked file:   $LINK -> $(readlink "$LINK")"
      [ -e "$LINK" ] || echo "  WARNING: the link points at nothing. Run \`pull\` or \`init\`"
    elif [ -f "$LINK" ]; then
      echo "linked file:   $LINK is a real file, not a link (run \`init\` to move it in)"
    else
      echo "linked file:   absent -- the preset picker will be empty. Run \`link\`"
    fi
    ;;

  *)
    die "unknown command \"$1\". Try: init, link, pull, push, status"
    ;;
esac
