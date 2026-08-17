/**
 * Decodes `fixtures/audio/*` to `.cache/fixtures/*.wav` (48kHz mono 16-bit PCM)
 * with the bundled ffmpeg. Cached by source mtime + size, so a re-run is free
 * unless the recording changed.
 *
 * Two path rules that matter in this repo:
 *  1. The audio filenames contain spaces, and one contains a DOUBLE space
 *     ("Cowboy  chords ..."). Never reconstruct a filename from a label title —
 *     always read the label's `sourceAudio` and resolve it relative to the
 *     label file's own directory.
 *  2. Paths go to ffmpeg as argv array elements, never through a shell string,
 *     so quoting never enters the picture.
 *
 * The fixtures are already AAC-LC 48kHz mono, so this is a container/codec
 * unwrap plus a float conversion — no resampling, and therefore no resampler
 * artifacts in the benchmark.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { readWav } from "../src/offline/wav.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
export const LABELS_DIR = join(REPO_ROOT, "fixtures", "labels");
export const CACHE_DIR = join(REPO_ROOT, ".cache");
export const WAV_DIR = join(CACHE_DIR, "fixtures");

const MANIFEST_PATH = join(WAV_DIR, "manifest.json");
export const TARGET_SAMPLE_RATE = 48000;

export type LabelFile = {
  version: number;
  title: string;
  sourceAudio: string;
  instrument?: string;
  tempoBpm?: number;
  tuning?: string[];
  timingNotes?: string;
  events: Array<{
    id: string;
    startMs: number;
    endMs: number;
    kind: "note" | "chord" | "unknown";
    label: string;
    pitches?: string[];
    pitchClasses?: string[];
    bendTo?: string;
    voicing?: string;
    required?: boolean;
  }>;
};

export type Fixture = {
  /** Label filename without `.json`. The key used everywhere else. */
  stem: string;
  labelPath: string;
  audioPath: string;
  wavPath: string;
  label: LabelFile;
};

type ManifestEntry = { audioPath: string; mtimeMs: number; size: number };

/**
 * Discover fixtures from the label files. The label is the source of truth for
 * where its audio lives; nothing here ever guesses a filename.
 */
export function discoverFixtures(): Fixture[] {
  const files = readdirSync(LABELS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();

  return files.map((name) => {
    const labelPath = join(LABELS_DIR, name);
    const label = JSON.parse(readFileSync(labelPath, "utf8")) as LabelFile;

    if (typeof label.sourceAudio !== "string" || label.sourceAudio.length === 0) {
      throw new Error(`${name}: missing "sourceAudio"`);
    }

    const stem = name.slice(0, -".json".length);
    // Resolved against the LABEL's directory, exactly as written — spaces,
    // double spaces and all.
    const audioPath = resolve(dirname(labelPath), label.sourceAudio);
    if (!existsSync(audioPath)) {
      throw new Error(`${name}: sourceAudio not found at ${audioPath}`);
    }

    return { stem, labelPath, audioPath, wavPath: join(WAV_DIR, `${stem}.wav`), label };
  });
}

function readManifest(): Record<string, ManifestEntry> {
  if (!existsSync(MANIFEST_PATH)) return {};
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, ManifestEntry>;
  } catch {
    return {};
  }
}

export type DecodeOutcome = Fixture & {
  decoded: boolean;
  wavBytes: number;
  /** Read back from the wav, not inferred from the file size. */
  sampleCount: number;
  sampleRate: number;
  channels: number;
  durationMs: number;
};

export function decodeFixtures(options: { force?: boolean; quiet?: boolean } = {}): DecodeOutcome[] {
  const bin = ffmpegPath;
  if (!bin) {
    throw new Error(
      "ffmpeg-static did not resolve a binary for this platform/arch. " +
        "Set FFMPEG_BIN to an ffmpeg executable."
    );
  }

  mkdirSync(WAV_DIR, { recursive: true });
  const manifest = readManifest();
  const fixtures = discoverFixtures();
  const outcomes: DecodeOutcome[] = [];

  for (const fixture of fixtures) {
    const source = statSync(fixture.audioPath);
    const cached = manifest[fixture.stem];
    const fresh =
      !options.force &&
      existsSync(fixture.wavPath) &&
      cached !== undefined &&
      cached.audioPath === fixture.audioPath &&
      cached.mtimeMs === source.mtimeMs &&
      cached.size === source.size;

    if (!fresh) {
      // Array argv: no shell, so the double space in the cowboy-chords filename
      // survives untouched.
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        fixture.audioPath,
        "-ac",
        "1",
        "-ar",
        String(TARGET_SAMPLE_RATE),
        "-f",
        "wav",
        "-acodec",
        "pcm_s16le",
        "-y",
        fixture.wavPath,
      ];
      const run = spawnSync(bin, args, { encoding: "utf8" });

      if (run.error) throw new Error(`ffmpeg failed to launch: ${run.error.message}`);
      if (run.status !== 0) {
        throw new Error(
          `ffmpeg exited ${run.status} for ${fixture.stem}\n${run.stderr ?? ""}`.trim()
        );
      }

      manifest[fixture.stem] = {
        audioPath: fixture.audioPath,
        mtimeMs: source.mtimeMs,
        size: source.size,
      };
    }

    // Read the wav back rather than inferring length from the file size —
    // ffmpeg writes a LIST chunk, so `data` does not start at byte 44.
    const wavBytes = statSync(fixture.wavPath).size;
    const wav = readWav(readFileSync(fixture.wavPath));
    const frames = Math.floor(wav.samples.length / Math.max(1, wav.channels));
    const durationMs = (frames / wav.sampleRate) * 1000;

    if (wav.sampleRate !== TARGET_SAMPLE_RATE) {
      throw new Error(
        `${fixture.stem}: decoded to ${wav.sampleRate}Hz, expected ${TARGET_SAMPLE_RATE}Hz`
      );
    }

    outcomes.push({
      ...fixture,
      decoded: !fresh,
      wavBytes,
      sampleCount: frames,
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      durationMs,
    });

    if (!options.quiet) {
      process.stdout.write(
        `${fresh ? "cached " : "decoded"}  ${fixture.stem.padEnd(42)} ` +
          `${(durationMs / 1000).toFixed(3)}s  ${frames} samples  ` +
          `${wav.sampleRate}Hz x${wav.channels}\n`
      );
    }
  }

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  return outcomes;
}

/* Run only when invoked directly, so `eval.ts` can import the helpers. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    decodeFixtures({ force: process.argv.includes("--force") });
  } catch (error) {
    process.stderr.write(`decode-fixtures: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
