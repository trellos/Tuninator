/**
 * The one place the ONNX runtime is loaded.
 *
 * The runtime is installed in this directory's own npm project
 * (`training/basic-pitch/package.json`, `npm ci` there), never in the root one,
 * and the root typecheck (`tsc --noEmit`, whose `include` covers `training/`)
 * runs without it. So the import below takes its specifier from a variable,
 * which the compiler does not resolve, and the handful of calls made on the
 * module are typed by the local interfaces here rather than by the package's
 * own declarations.
 *
 * Threads are capped at two: this evaluation shares its machine.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type OrtTensor = { readonly data: Float32Array; readonly dims: readonly number[] };
type OrtSession = {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
};
type OrtModule = {
  Tensor: new (type: "float32", data: Float32Array, dims: readonly number[]) => OrtTensor;
  InferenceSession: {
    create(
      path: string,
      options: {
        intraOpNumThreads: number;
        interOpNumThreads: number;
        executionMode: "sequential";
        graphOptimizationLevel: "all";
      },
    ): Promise<OrtSession>;
  };
};

const HERE = dirname(fileURLToPath(import.meta.url));

/** The model's fixed input length and output shape, from the ONNX signature. */
export const WINDOW_SAMPLES = 43844;
export const WINDOW_FRAMES = 172;
export const N_NOTES = 88;
export const N_CONTOUR = 264;

/** Output names, as `basic_pitch/inference.py` maps them for the ONNX file. */
const OUT = { note: "StatefulPartitionedCall:1", onset: "StatefulPartitionedCall:2", contour: "StatefulPartitionedCall:0" };
const IN = "serving_default_input_2:0";

export type WindowOutput = {
  /** [WINDOW_FRAMES x N_NOTES], row-major, one row per frame. */
  note: Float32Array;
  onset: Float32Array;
  /** [WINDOW_FRAMES x N_CONTOUR]. */
  contour: Float32Array;
};

export type Model = {
  /** Runs a batch of windows, each exactly WINDOW_SAMPLES long. */
  run(windows: readonly Float32Array[]): Promise<WindowOutput[]>;
  runtimeVersion: string;
};

async function loadOrt(): Promise<{ ort: OrtModule; version: string }> {
  const spec = "onnxruntime-node";
  if (!existsSync(join(HERE, "node_modules", spec))) {
    throw new Error(
      `${spec} is not installed. Run \`npm ci\` in training/basic-pitch/ first (its own package.json; ` +
        "never the root one).",
    );
  }
  const mod = (await import(spec)) as { default?: OrtModule } & OrtModule;
  const ort = (mod.default ?? mod) as OrtModule & { env?: { versions?: { node?: string; common?: string } } };
  const version = ort.env?.versions?.node ?? ort.env?.versions?.common ?? "unknown";
  return { ort, version };
}

export async function loadModel(onnxPath: string, batchLimit = 8): Promise<Model> {
  const { ort, version } = await loadOrt();
  const session = await ort.InferenceSession.create(onnxPath, {
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
    executionMode: "sequential",
    graphOptimizationLevel: "all",
  });
  if (session.inputNames[0] !== IN) throw new Error(`unexpected input ${session.inputNames.join(",")}`);

  async function runBatch(windows: readonly Float32Array[]): Promise<WindowOutput[]> {
    const n = windows.length;
    const input = new Float32Array(n * WINDOW_SAMPLES);
    windows.forEach((w, i) => {
      if (w.length !== WINDOW_SAMPLES) throw new Error(`window ${i} has ${w.length} samples`);
      input.set(w, i * WINDOW_SAMPLES);
    });
    const result = await session.run({ [IN]: new ort.Tensor("float32", input, [n, WINDOW_SAMPLES, 1]) });
    const pick = (name: string, width: number): Float32Array[] => {
      const t = result[name];
      if (t === undefined) throw new Error(`missing output ${name}`);
      const per = WINDOW_FRAMES * width;
      if (t.data.length !== n * per) throw new Error(`${name}: ${t.data.length} values for ${n} windows`);
      return Array.from({ length: n }, (_, i) => t.data.slice(i * per, (i + 1) * per));
    };
    const note = pick(OUT.note, N_NOTES);
    const onset = pick(OUT.onset, N_NOTES);
    const contour = pick(OUT.contour, N_CONTOUR);
    return note.map((_, i) => ({
      note: note[i] as Float32Array,
      onset: onset[i] as Float32Array,
      contour: contour[i] as Float32Array,
    }));
  }

  return {
    runtimeVersion: version,
    async run(windows) {
      const out: WindowOutput[] = [];
      for (let i = 0; i < windows.length; i += batchLimit) {
        out.push(...(await runBatch(windows.slice(i, i + batchLimit))));
      }
      return out;
    },
  };
}
