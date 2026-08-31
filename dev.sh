#!/usr/bin/env bash

# ── Configurable host / ports ─────────────────────────────────────────────────
BACKEND_HOST=${BACKEND_HOST:-localhost}
BACKEND_PORT=${BACKEND_PORT:-3000}
FRONTEND_HOST=${FRONTEND_HOST:-localhost}
FRONTEND_PORT=${FRONTEND_PORT:-5173}

# A Mini App shown in the messenger panel is served on its own hostname, pointed at this same
# host and port (see backend/src/tg/webviewTickets.ts for why it cannot share the panel's).
# Unset, apps open in a browser tab instead.
WEBVIEW_PUBLIC_ORIGIN=${WEBVIEW_PUBLIC_ORIGIN:-}

# Services always bind to 0.0.0.0; BACKEND_HOST/FRONTEND_HOST are display/proxy names only
PROXY_HOST=127.0.0.1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Vendored browser runtime ──────────────────────────────────────────────────
# A dev container that ships without Chrome's system libraries cannot start any CloakBrowser
# build, and the failure looks like a bad download rather than a missing libglib. Run
# scripts/dev-browser-deps.sh to unpack them into the data dir; this picks them up. Absent
# in production, where the image installs the packages itself, so it is a no-op there.
BROWSER_DEPS_ENV="$SCRIPT_DIR/backend/data/chrome-deps/env.sh"
if [ -f "$BROWSER_DEPS_ENV" ]; then
  . "$BROWSER_DEPS_ENV"
  echo "Using vendored browser runtime from backend/data/chrome-deps"
fi

# ── .env setup ────────────────────────────────────────────────────────────────
if [ ! -f backend/.env ]; then
  cp env.example backend/.env
  echo ""
  echo "Created backend/.env from env.example."
  echo ""
fi

# The backend refuses to boot on an empty or publicly-known JWT_SECRET, so
# generate a random one for local dev if the current value is missing/placeholder.
if ! grep -q "^JWT_SECRET=." backend/.env 2>/dev/null \
   || grep -qE "^JWT_SECRET=(change-me-in-production|changeme|secret)$" backend/.env 2>/dev/null; then
  SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  if grep -q "^JWT_SECRET=" backend/.env 2>/dev/null; then
    sed "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" backend/.env > backend/.env.tmp && mv backend/.env.tmp backend/.env
  else
    printf 'JWT_SECRET=%s\n' "$SECRET" >> backend/.env
  fi
  echo "Generated a random JWT_SECRET in backend/.env for local development."
  echo ""
fi

if grep -q "^ADMIN_PASSWORD=changeme$" backend/.env 2>/dev/null; then
  echo ""
  echo "NOTE: backend/.env uses the default ADMIN_PASSWORD (changeme)."
  echo "      You'll be prompted to change it on first login; set a real one for deployment."
  echo ""
fi

# ── Dependencies ──────────────────────────────────────────────────────────────
echo "Installing dependencies..."
# utf-8-validate (optional ws perf addon) needs make to compile from source which
# may not be available -- use --ignore-scripts and restore better-sqlite3's prebuilt
(cd backend && npm install --ignore-scripts) || true
(cd backend/node_modules/better-sqlite3 && node ../prebuild-install/bin.js 2>&1 || true)
(cd frontend && npm install --no-audit) || true

# ── Cleanup on exit ───────────────────────────────────────────────────────────
BACKEND_PID=""
FRONTEND_PID=""

# Each service is a chain: subshell -> npm -> sh -c -> tsx/vite -> the node that
# listens. Killing only the pid we hold leaves the rest of the chain alive, and a
# surviving `tsx watch` keeps its ~80MB and respawns the server we just stopped, so
# walk the tree and kill depth-first.
kill_tree() {
  local pid=$1
  [ -z "$pid" ] && return 0
  local kid
  for kid in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$kid"; done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  echo ""
  echo "Stopping..."
  kill_tree "$BACKEND_PID"
  kill_tree "$FRONTEND_PID"
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Kill any existing processes on configured ports ───────────────────────────
kill_port() {
  local PORT=$1
  local PIDS
  PIDS=$(ss -tlnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+')
  [ -z "$PIDS" ] && return 0
  echo "Killing existing process(es) on port $PORT: $PIDS"
  kill -9 $PIDS 2>/dev/null || true
  sleep 0.5
}

for PORT in $BACKEND_PORT $FRONTEND_PORT; do
  kill_port "$PORT"
done

# kill_port only reaches whatever holds the socket, so watchers orphaned by an earlier
# run (a killed terminal, a crash before the trap fired) survive it and pile up at
# ~80MB each. Match on this checkout's paths so other projects are left alone.
kill_stale_watchers() {
  local pattern pids
  for pattern in "$SCRIPT_DIR/backend/node_modules/.bin/tsx" \
                 "$SCRIPT_DIR/frontend/node_modules/.bin/vite"; do
    pids=$(pgrep -f "$pattern" 2>/dev/null | grep -v "^$$\$")
    [ -z "$pids" ] && continue
    echo "Killing stale watcher(s): $(echo "$pids" | tr '\n' ' ')"
    kill -9 $pids 2>/dev/null || true
  done
}
kill_stale_watchers

# ── Start services ────────────────────────────────────────────────────────────
echo ""
echo "  Backend:  http://${BACKEND_HOST}:${BACKEND_PORT}"
echo "  Frontend: http://${FRONTEND_HOST}:${FRONTEND_PORT}"
if [ -n "$WEBVIEW_PUBLIC_ORIGIN" ]; then
  echo "  Mini App viewer: ${WEBVIEW_PUBLIC_ORIGIN}"
fi
echo ""
echo "Press Ctrl+C to stop both."
echo ""

(cd backend && HOST=0.0.0.0 PORT=$BACKEND_PORT DISPLAY_HOST=$BACKEND_HOST \
  WEBVIEW_PUBLIC_ORIGIN=$WEBVIEW_PUBLIC_ORIGIN npm run dev) &
BACKEND_PID=$!

printf "Waiting for backend"
until (echo > /dev/tcp/127.0.0.1/$BACKEND_PORT) 2>/dev/null; do
  printf "."
  sleep 1
done
echo " ready"

(cd frontend && BACKEND_HOST=$PROXY_HOST BACKEND_PORT=$BACKEND_PORT \
  WEBVIEW_PUBLIC_ORIGIN=$WEBVIEW_PUBLIC_ORIGIN npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" --strictPort) &
FRONTEND_PID=$!

wait
