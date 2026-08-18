import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const libRoot = path.resolve(here, "..", "..");

export default defineConfig({
  test: {
    // The demo's own logic — most of it the channel selection the library
    // deliberately does not do.
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    // Same aliases as vite.config.ts: run against the library's source so a
    // stale `dist/` cannot make these tests pass.
    alias: [
      { find: /^tuninator\/web$/, replacement: path.join(libRoot, "src", "web.ts") },
      { find: /^tuninator$/, replacement: path.join(libRoot, "src", "index.ts") },
    ],
  },
});
