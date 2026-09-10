import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Puts the vendored Chrome runtime on LD_LIBRARY_PATH, as dev.sh does for the app
    setupFiles: ["./vitest.setup.ts"],
    // The data dir holds the downloaded browser and its profiles: thousands of files,
    // some of them written by whichever user ran the app, which is neither worth
    // scanning nor always readable from here.
    exclude: ["**/node_modules/**", "**/dist/**", "data/**"],
    watchExclude: ["**/node_modules/**", "data/**"],
    server: { watch: { ignored: ["**/data/**"] } },
  },
});
