# ── Stage 1: Build frontend ────────────────────────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Build backend + compile native addons + prune to prod deps ────────
# Debian rather than Alpine: the native addon has to be built against the same libc
# the production stage runs, and that stage needs glibc for the browser (see below).
FROM node:22-bookworm-slim AS backend-builder
WORKDIR /app
# python3/make/g++ required to compile better-sqlite3 native addon
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# ── Stage 3: Production image ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS production
WORKDIR /app

ENV NODE_ENV=production

# V8 sizes its default heap from the memory it can see, which is generous: ~4GB on a 24GB
# host, and still roughly half of RAM on a small one. Node only collects hard as it nears
# that ceiling, so on a 2GB box the heap alone can grow past what is left after SQLite, the
# Telegram clients and (where enabled) a browser -- the OOM killer arrives first. Capping it
# makes GC start early enough to matter. Override the whole variable on a larger host.
ENV NODE_OPTIONS="--max-old-space-size=512"

# The Cloudflare "I am not a bot" solver runs CloakBrowser, a Chromium built with
# source-level fingerprint patches. The browser itself is downloaded on demand into the
# data dir (keeping the image small), but its shared libraries and fonts belong here. This
# is the dependency set that Chromium expects, and it is why the image is Debian: the build
# is glibc-only. Alpine could only offer its own musl build of a stock Chromium, which is
# the thing a challenge is looking for.
#
# xvfb gives the browser a virtual display so it can run headed (far better challenge
# pass rate than headless); the app starts one X server of its own on first launch and
# every browser shares it. x11vnc serves such a display to the panel, for the browser a
# person drives by hand to log a job in once -- it listens on the loopback only, behind
# the app's own ticketed bridge. gosu lets the entrypoint fix data-dir ownership as root
# and then drop to the non-root `node` user.
#
# Only fonts-liberation ships here, as a Latin fallback that is always present: a browser
# that cannot draw a glyph measures text unlike any real one. The three Noto packages this
# used to install (fonts-noto-core, fonts-noto-cjk, fonts-noto-color-emoji) come to roughly
# 140MB between them for a feature most installs never turn on, so the CJK and emoji faces
# are downloaded into the data dir alongside the browser instead (see installCfFonts) and
# survive an upgrade with it.
#
# Note that nothing replaces fonts-noto-core: scripts that are neither Latin nor CJK
# (Cyrillic, Greek, Arabic, Devanagari) now render as boxes. That is the deliberate trade
# for the size. If a challenge is ever found to need one, add the face to CF_FONTS so it
# downloads on demand rather than putting the package back in the image.
#
# fontconfig is kept for its fc-cache, which that install runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      gosu \
      xvfb \
      x11vnc \
      libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libatspi2.0-0 libx11-6 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxrandr2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 \
      libasound2 libxcb1 libexpat1 libglib2.0-0 libudev1 \
      fontconfig fonts-liberation \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# xvfb pulls libgl1 -> libglx-mesa0 -> libgl1-mesa-dri -> libllvm*: a software OpenGL
# rasteriser worth ~100MB, almost all of it the LLVM runtime. They are hard dependencies,
# so dpkg has to be told to drop them anyway; the GL dispatch library Xvfb links against
# (libgl1) stays.
#
# This is only safe because the browser is launched with --use-gl=angle
# --use-angle=swiftshader (see cfBrowser.ts), which renders through Chromium's own bundled
# SwiftShader and never asks the system for GL. Forcing the driver out leaves libglx-mesa0
# installed but gutted, so anything that does ask gets "GLX is not present" and ANGLE fails
# to initialise -- it does not fall back by itself. Removing those flags means putting these
# packages back.
#
# The LLVM runtime is matched by pattern rather than named: its package tracks the Debian
# release (libllvm15 on bookworm), and a base-image bump must not quietly stop removing it.
#
# The smoke test only proves the X server still comes up. It cannot launch the browser to
# check the rest: CloakBrowser is downloaded into the data dir at runtime, so there is no
# binary in the image. The runtime equivalent is the self-test in Settings, which reports a
# missing WebGL as a warning.
# The proof is the display socket, not the child's PID -- an Xvfb that died would still be
# an unreaped zombie that `kill -0` reports as alive.
RUN set -eu; \
    purge="$(dpkg-query -W -f='${Package}\n' libgl1-mesa-dri 'libllvm*' 2>/dev/null || true)"; \
    if [ -n "$purge" ]; then \
      dpkg --purge --force-depends $purge; \
    else \
      echo "no Mesa/LLVM packages to purge; the base image may have changed"; \
    fi; \
    Xvfb :99 -screen 0 1280x800x24 -nolisten tcp & \
    xvfb_pid=$!; \
    sleep 3; \
    test -S /tmp/.X11-unix/X99 || { echo "Xvfb did not come up after the Mesa purge"; exit 1; }; \
    kill "$xvfb_pid" 2>/dev/null || true

# playwright-core is only the driver and never downloads a browser of its own; CloakBrowser
# places one under the data dir on demand and the app resolves it at launch. The cache is
# pointed at the data dir in code, so it lands on the volume rather than in $HOME.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/dist        ./dist
COPY --from=backend-builder /app/package.json ./package.json
COPY --from=frontend-builder /frontend/dist  ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data && chmod +x /usr/local/bin/docker-entrypoint.sh

# Stamp the build so the running process knows what it is. Without these the panel treats
# the image as unpublished and leaves the update check off, rather than comparing a local
# build against a release. Filled by the publish workflow; a hand-built image has neither.
ARG BEMBY_VERSION=""
ARG BEMBY_CHANNEL=""
ENV BEMBY_VERSION=${BEMBY_VERSION}
ENV BEMBY_CHANNEL=${BEMBY_CHANNEL}

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
# Prefer IPv4 to avoid IPv6 routing issues in container environments
CMD ["node", "--dns-result-order=ipv4first", "dist/server.js"]
