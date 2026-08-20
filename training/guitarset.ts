/**
 * GuitarSet access: take listing, JAMS note onsets, and the player grouping
 * the split is built on.
 *
 * GuitarSet (Xi et al., ISMIR 2018; Zenodo record 3371780): 360 excerpts,
 * six players (the leading two digits of every take name), comping and solo
 * passes over the same progressions, with per-string note annotations derived
 * from a hexaphonic pickup. Two mono audio flavours are used here:
 *
 *   mic     audio_mono-mic — the room microphone.
 *   pickup  audio_mono-pickup_mix — the summed hexaphonic pickup, the
 *           closest thing GuitarSet has to a DI.
 *
 * `prepare` (see README) converts both to 48kHz mono 16-bit WAV so every
 * feature this pipeline computes lives on the exact grid the fixture corpus
 * uses.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type GuitarSetLabel = { id: string; startMs: number };

export type GuitarSetTake = {
  /** e.g. "02_BN1-129-Eb_comp" */
  name: string;
  /** "00".."05" — the grouping unit for every split. */
  player: string;
  style: "comp" | "solo";
  jamsPath: string;
};

export function listTakes(jamsDir: string): GuitarSetTake[] {
  return readdirSync(jamsDir)
    .filter((f) => f.endsWith(".jams"))
    .sort()
    .map((f) => {
      const name = f.replace(/\.jams$/, "");
      return {
        name,
        player: name.slice(0, 2),
        style: name.endsWith("_solo") ? "solo" : "comp",
        jamsPath: join(jamsDir, f),
      };
    });
}

/**
 * Note onsets for one take, merged across the six per-string annotations and
 * then across simultaneous strings: onsets closer together than `mergeMs`
 * collapse to the earliest, because that is what this repo's own ground truth
 * does — a strummed chord is ONE labelled event in `fixtures/labels/**`, not
 * six, and the target rule being ported (`measure-decision-separability.ts`
 * `collect()`) was built against labels with that shape. 30ms is inside the
 * 70ms attribution window and wider than the spread of a fast strum's string
 * arrivals in the fixtures' own labelling practice.
 */
export function loadOnsets(take: GuitarSetTake, mergeMs = 30): GuitarSetLabel[] {
  const jams = JSON.parse(readFileSync(take.jamsPath, "utf8")) as {
    annotations: Array<{
      namespace: string;
      data: Array<{ time: number; duration: number; value: number }>;
    }>;
  };
  const onsets: number[] = [];
  for (const annotation of jams.annotations) {
    if (annotation.namespace !== "note_midi") continue;
    for (const note of annotation.data) onsets.push(note.time * 1000);
  }
  onsets.sort((a, b) => a - b);

  const merged: GuitarSetLabel[] = [];
  for (const at of onsets) {
    const last = merged.length > 0 ? (merged[merged.length - 1] as GuitarSetLabel) : null;
    if (last !== null && at - last.startMs < mergeMs) continue;
    merged.push({ id: `n${merged.length}`, startMs: at });
  }
  return merged;
}
