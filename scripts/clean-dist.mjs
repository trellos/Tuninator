/**
 * Clears dist/ before tsup runs.
 *
 * tsup's own `clean` is per-config, and the library and worklet configs build
 * concurrently — so a clean in one can delete output the other has already
 * written. Which build wins is a coin flip, and the failure looks like a
 * missing worklet asset rather than a build ordering bug. Cleaning once, up
 * front, removes the race.
 *
 * Uses node rather than `rm -rf` so it works on Windows too.
 */

import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
await rm(dist, { recursive: true, force: true });
