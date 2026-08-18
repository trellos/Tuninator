import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Library build: the general library (`.`) and the browser worker
    // (`./web`). ESM + type declarations.
    entry: { index: "src/index.ts", web: "src/web.ts" },
    format: ["esm"],
    dts: true,
    // Cleaning is done once by scripts/clean-dist.mjs. A per-config clean races
    // the other config's output.
    clean: false,
    sourcemap: true,
    target: "es2022",
    platform: "browser",
  },
  {
    // Worklet build: ONE self-contained file with no import/export statements.
    // AudioWorkletGlobalScope has no module loader on older targets, so the
    // whole question is avoided by bundling to an IIFE.
    entry: { "tuninator-worklet": "src/workers/web-audio-processor.ts" },
    format: ["iife"],
    dts: false,
    clean: false,
    sourcemap: false,
    target: "es2022",
    platform: "browser",
    // tsup appends .global.js for iife by default; force the documented name.
    outExtension: () => ({ js: ".js" }),
  },
]);
