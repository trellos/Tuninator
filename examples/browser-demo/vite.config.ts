import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The sibling checkout of the library. Declared in package.json as `file:../Tuninator`. */
const LIB_ROOT = path.resolve(here, "..", "Tuninator");

/**
 * The library's PUBLIC entry point, in source form.
 *
 * `tuninator` is declared as `file:../Tuninator`, but the library's `dist/` is
 * built by a concurrent workstream and may not exist yet, so resolving the
 * package through its `exports` map would fail. Aliasing straight at
 * `src/index.ts` keeps the demo building today and gives it live reload when
 * the library changes. It is still the public entry point: this alias is the
 * only path into the library, and the demo never imports `tuninator/src/**`.
 */
const LIB_ENTRY = path.join(LIB_ROOT, "src", "index.ts");

/** Built worklet asset produced by `npm run build` in the library. */
const WORKLET_SRC = path.join(LIB_ROOT, "dist", "tuninator-worklet.js");
const WORKLET_DEST_DIR = path.join(here, "public", "assets");
const WORKLET_DEST = path.join(WORKLET_DEST_DIR, "tuninator-worklet.js");

/**
 * Copies `../Tuninator/dist/tuninator-worklet.js` into `public/assets/` so the
 * demo can hand the library a `workletUrl` of `/assets/tuninator-worklet.js`.
 *
 * The library's `dist/` does not exist until the library has been built, so a
 * missing worklet is a warning, never a build failure -- the demo still runs
 * against the mock, and the real path surfaces `worklet-load-failed` in the UI.
 */
function copyWorkletPlugin(): Plugin {
  let lastCopiedMtimeMs = -1;

  const copy = (logger: { info: (m: string) => void; warn: (m: string) => void }): void => {
    if (!existsSync(WORKLET_SRC)) {
      logger.warn(
        `[tuninator] worklet not found at ${path.relative(here, WORKLET_SRC)} — ` +
          `run \`npm run build\` in the library. The demo still works against the mock; ` +
          `the live path will report \`worklet-load-failed\`.`
      );
      return;
    }
    const mtimeMs = statSync(WORKLET_SRC).mtimeMs;
    if (mtimeMs === lastCopiedMtimeMs) return;
    mkdirSync(WORKLET_DEST_DIR, { recursive: true });
    copyFileSync(WORKLET_SRC, WORKLET_DEST);
    lastCopiedMtimeMs = mtimeMs;
    logger.info(`[tuninator] copied worklet -> public/assets/tuninator-worklet.js`);
  };

  return {
    name: "tuninator-copy-worklet",
    buildStart() {
      copy({ info: (m) => this.info(m), warn: (m) => this.warn(m) });
    },
    configureServer(server) {
      const logger = {
        info: (m: string) => server.config.logger.info(m),
        warn: (m: string) => server.config.logger.warn(m),
      };
      copy(logger);
      // Pick the worklet up as soon as the library finishes a build.
      server.watcher.add(WORKLET_SRC);
      server.watcher.on("add", (file) => {
        if (path.resolve(file) === WORKLET_SRC) copy(logger);
      });
      server.watcher.on("change", (file) => {
        if (path.resolve(file) === WORKLET_SRC) copy(logger);
      });
    },
  };
}

export default defineConfig({
  plugins: [copyWorkletPlugin()],
  resolve: {
    alias: [{ find: /^tuninator$/, replacement: LIB_ENTRY }],
  },
  server: {
    fs: {
      // The alias points outside this project root; let the dev server serve it.
      allow: [here, LIB_ROOT],
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
