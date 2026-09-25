/**
 * Phase 3 of `docs/external-models-eval-prompt.md` for cstr/hft-transformer-GGUF:
 * end to end, for the one question that cleared its Phase 2 bar.
 *
 * Q2 (same-pitch cuts) cleared both halves of its bar on the derivation takes
 * (`phase2.ts`: AUC 0.710 on the boundary target against 0.698, and 0.712
 * with a 95% lower bound of 0.674 on the rows DECISION-030's gate passes).
 * Q1 and Q3 did not, so nothing is built for them. Everything below was fixed
 * in writing before the held-out takes were read and before any gated run.
 *
 * THE GATE. The tracker decision Q2 scored: an accepted, settled rearticulation
 * that is NOT a pitch change — a cut between two same-pitch Notes
 * (`note-tracker.ts`, `if (rearticulated && settled)`). The cut is refused
 * (the Note continues, exactly as for a rejected verdict) when
 *   S2 < 0.5,
 * S2 being Q2's score: the largest onset activation within +-40ms of the cut
 * over the keys of the Note's pitch classes (its harmony pitches when it has
 * them, else its dominant pitch, else all keys), read from the DEEP reading —
 * the one the deep lane could make at the first ruling holding audio 40ms past
 * the cut. 0.5 is the model's own decision threshold and the operating point of
 * Q2's 2x2; it is not swept.
 *
 * THE READINGS are precomputed per take (`--prep`): the baseline engine's
 * rulings, each read by the model on the audio the ring holds then (reusing
 * `phase2.ts`'s cache, reading any ruling it did not need). A gated run whose
 * cuts move still finds a reading for any time. Written to
 * `training/out/hft-transformer/gate/<sha256 of the take's 48kHz samples>.json`
 * so the dev-only hook in `src/offline/analyzer.ts` (phase3-hook.patch, never
 * committed) finds it by the audio alone when HFT_GATE_DIR is set, under
 * `npm run eval` and the measurement scripts unchanged.
 *
 * WHAT COUNTS, stated in advance: a WIN needs derivation extra Notes (and
 * split events) to fall with derivation missed labels NOT rising, the
 * standing bar of AGENTS.md section 4 and DECISION-030. Anything else is a
 * finding. Held-out figures are reported beside it, as held-out. The veto can
 * only remove same-pitch cuts, so what it risks is real re-picks: in Q2's
 * derivation 2x2 at 0.5 it refuses 145 cuts that should not have been made
 * and 186 that should.
 *
 * Usage:
 *   npx tsx training/hft-transformer/phase3.ts --prep        # after phase2 derivation and heldout
 *   git apply training/hft-transformer/phase3-hook.patch
 *   npm run eval ; npx tsx scripts/measure-downstream-ledger.ts --all ; \
 *     npx tsx scripts/measure-splits.ts ; npx tsx scripts/measure-splits.ts --subset=slow
 *   HFT_GATE_DIR=training/out/hft-transformer/gate  (the same four)
 *   git apply -R training/hft-transformer/phase3-hook.patch
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSamples } from "../../src/offline/analyzer.js";
import { downmixToMono, readWav } from "../../src/offline/wav.js";
import { DeepLane, type DeepRegionRequest } from "../../src/engine/deep/deep-lane.js";
import type { AudioRing } from "../../src/engine/ring-buffer.js";
import { decodeFixtures } from "../../scripts/decode-fixtures.js";

const OUT = "training/out/hft-transformer";
const BIN = join(OUT, "bin/hft-read");
const GGUF = join(OUT, "hf/hft-transformer-f32.gguf");
const KEYS = 88;
const NF = 128;
const RS_WIDTH = 19;
const RING_SECONDS = 4;

if (!process.argv.includes("--prep")) {
  console.error("usage: npx tsx training/hft-transformer/phase3.ts --prep   (see the header)");
  process.exit(2);
}

// The same observation of the deep lane's rulings as phase2.ts.
type Ruling = { held: number };
let sink: Ruling[] | null = null;
const originalDrain = DeepLane.prototype.drain;
DeepLane.prototype.drain = function drain(this: DeepLane, now: number, ring: AudioRing) {
  const pending = (this as unknown as { pendingRegion: DeepRegionRequest | null }).pendingRegion;
  const out = originalDrain.call(this, now, ring);
  if (sink !== null && pending !== null && pending.notBefore <= now) sink.push({ held: ring.writeIndex });
  return out;
};
const end16For = (held48: number): number => Math.floor((held48 - RS_WIDTH) / 3) + 1;
const ring16For = (held48: number): number => {
  const first48 = held48 - RING_SECONDS * 48000;
  if (first48 <= 0) return 0;
  return Math.ceil(Math.ceil((first48 + RS_WIDTH - 1) / 3) / 256) * 256;
};

/** Every cached deep reading of a take, keyed "end16 ring16". */
function cachedReadings(stem: string): Map<string, { first: number; onset: Float32Array }> {
  const out = new Map<string, { first: number; onset: Float32Array }>();
  const dir = join(OUT, "reads", stem);
  if (!existsSync(dir)) return out;
  const per = 4 + 4 * NF * KEYS * 4;
  for (const f of readdirSync(dir)) {
    const m = /^(take-[0-9a-f]+|extra-[0-9a-f]+)\.reads\.txt$/.exec(f);
    if (m === null) continue;
    const binPath = join(dir, `${m[1]}.deep.bin`);
    if (!existsSync(binPath)) continue;
    const keys = readFileSync(join(dir, f), "utf8").trim().split("\n");
    const buf = readFileSync(binPath);
    keys.forEach((key, i) => {
      const base = i * per;
      out.set(key, {
        first: buf.readInt32LE(base),
        onset: new Float32Array(buf.buffer.slice(buf.byteOffset + base + 4, buf.byteOffset + base + 4 + NF * KEYS * 4)),
      });
    });
  }
  return out;
}

const gateDir = join(OUT, "gate");
mkdirSync(gateDir, { recursive: true });
const index: Record<string, string> = {};
for (const fixture of decodeFixtures({ quiet: true })) {
  const wav = readWav(readFileSync(fixture.wavPath));
  const mono = downmixToMono(wav.samples, wav.channels);
  const sha = createHash("sha256").update(Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength)).digest("hex");
  const rulings: Ruling[] = [];
  sink = rulings;
  analyzeSamples(mono, wav.sampleRate);
  sink = null;
  rulings.sort((a, b) => a.held - b.held);

  let cache = cachedReadings(fixture.stem);
  const keyOf = (r: Ruling): string => `${end16For(r.held)} ${ring16For(r.held)}`;
  const missing = [...new Set(rulings.map(keyOf))].filter((k) => !cache.has(k));
  if (missing.length > 0) {
    const pcm = join(OUT, "reads", fixture.stem, "pcm16k.f32");
    if (!existsSync(pcm)) throw new Error(`${fixture.stem}: run phase2.ts for this take first`);
    const spec = missing.join("\n") + "\n";
    const tag = createHash("sha256").update(spec).digest("hex").slice(0, 16);
    const prefix = join(OUT, "reads", fixture.stem, `extra-${tag}`);
    writeFileSync(`${prefix}.reads.txt`, spec);
    const r = spawnSync(BIN, ["reads", GGUF, pcm, `${prefix}.reads.txt`, `${prefix}.deep.bin`, "2"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`hft-read reads failed: ${r.stderr}`);
    cache = cachedReadings(fixture.stem);
  }

  // Per ruling: held (48kHz samples), first frame, and per frame the largest
  // onset activation over each pitch class's keys.
  const gate = rulings.map((r) => {
    const reading = cache.get(keyOf(r));
    if (reading === undefined) throw new Error(`${fixture.stem}: no reading for ${keyOf(r)}`);
    const pcMax: number[] = [];
    for (let i = 0; i < NF; i++) {
      const row = new Array<number>(12).fill(0);
      for (let k = 0; k < KEYS; k++) {
        const pc = (k + 21) % 12;
        row[pc] = Math.max(row[pc] as number, reading.onset[i * KEYS + k] as number);
      }
      for (const v of row) pcMax.push(Math.round(v * 1e5) / 1e5);
    }
    return { held: r.held, first: reading.first, pcMax };
  });
  writeFileSync(join(gateDir, `${sha}.json`), JSON.stringify({ stem: fixture.stem, rulings: gate }));
  index[fixture.stem] = sha;
  process.stderr.write(`${fixture.stem}: ${rulings.length} rulings, ${missing.length} read now\n`);
}
writeFileSync(join(gateDir, "index.json"), JSON.stringify(index, null, 1));
console.log(`gate data for ${Object.keys(index).length} takes in ${gateDir}`);
