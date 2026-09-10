import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import type { Plugin } from "vite";
import http from "node:http";

const backend = `http://${process.env.BACKEND_HOST ?? "localhost"}:${process.env.BACKEND_PORT ?? 3000}`;

/**
 * In dev the panel is served by Vite, so a request for the Mini App viewer host arrives here
 * rather than at the backend. The viewer owns its whole host, from the root down -- that is the
 * point of it -- so anything naming that host is handed straight to the backend instead of
 * being answered with the panel's index.html.
 */
function webviewHostProxy(): Plugin | undefined {
  const origin = process.env.WEBVIEW_PUBLIC_ORIGIN?.trim();
  if (!origin) return undefined;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    console.warn(`[vite] ignoring WEBVIEW_PUBLIC_ORIGIN: "${origin}" is not a valid origin`);
    return undefined;
  }
  const target = new URL(backend);
  return {
    name: "bemby-webview-host",
    configureServer(server) {
      // Ahead of Vite's own middleware, or index.html answers first. Piped by hand rather than
      // through a proxy library: this is one stream copy and needs no extra dependency.
      server.middlewares.use((req, res, next) => {
        const name = String(req.headers.host ?? "").toLowerCase().split(":")[0];
        if (name !== host) return next();
        const proxied = http.request(
          {
            host: target.hostname,
            port: target.port,
            method: req.method,
            path: req.url,
            headers: { ...req.headers, host: req.headers.host ?? host },
          },
          (upstream) => {
            res.writeHead(upstream.statusCode ?? 502, upstream.headers);
            upstream.pipe(res);
          },
        );
        proxied.on("error", (err) => {
          res.statusCode = 502;
          res.end(`viewer backend unreachable: ${err.message}`);
        });
        req.pipe(proxied);
      });
    },
  };
}

export default defineConfig({
  plugins: [vue(), webviewHostProxy()].filter(Boolean) as Plugin[],
  server: {
    allowedHosts: true,
    hmr: {
      // Prevent mobile network idle-timeout from triggering full page reloads.
      // Mobile NAT gateways often kill idle WebSocket connections after ~30-60s;
      // increasing the client timeout here gives the HMR socket time to reconnect
      // without immediately falling back to a hard reload.
      timeout: 120000,
    },
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://${process.env.BACKEND_HOST ?? "localhost"}:${process.env.BACKEND_PORT ?? 3000}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // The libraries change with a dependency bump, the panel with every release. Split
        // apart, an upgrade re-downloads the panel and leaves the libraries cached.
        manualChunks: {
          vendor: ["vue", "vue-router", "axios"],
        },
      },
    },
  },
});
