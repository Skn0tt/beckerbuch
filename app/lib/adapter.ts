/**
 * Learned adapter over frozen OpenAI ingredient embeddings.
 *
 * The general-purpose embedding model (`text-embedding-3-small`) puts
 * German word-order / compound variants of the *same* ingredient too far
 * apart — "Knoblauchzehen" vs "Zehen Knoblauch", "gehackte Tomaten" vs
 * "Tomaten, gehackt". OpenAI embedding models can't be fine-tuned, so
 * instead we learn a small map on top of the frozen vectors and cluster
 * in the projected space (cosine on the projection). The map is trained
 * offline on labeled ingredient pairs (see `ml/ingredient-adapter/`) to
 * pull positives together while keeping hard negatives (Paprika vs
 * Paprikapulver) apart.
 *
 * Two adapter shapes are supported:
 *  - **linear** (`kind: "linear"` / no `kind`): a single low-rank matrix
 *    `W`, `z = W·x`. Cheap, but a single global metric can't separate
 *    near-collinear pairs that carry opposite labels (e.g. "Zitrone" ≈
 *    "Zitronen" positive vs "Zitrone" ≠ "Zitronenschale" negative).
 *  - **mlp** (`kind: "mlp"`): a two-layer perceptron with a ReLU hidden
 *    layer, `z = W₂·relu(W₁·x + b₁)`. The nonlinearity lets it carve
 *    non-collinear decision regions, raising the capacity ceiling that
 *    the linear map hit on the harder near-synonym negatives.
 *
 * Layering: the adapter is applied *after* the embedding cache read (in
 * `dedup.ts`), so `ingredient_embeddings` keeps storing raw OpenAI
 * vectors and retraining never invalidates the cache. Input stays full
 * 1536-dim; only the output is low-rank, so nothing about the embedding
 * request or cache key changes.
 *
 * Always on: the shipping artifact is baked into the bundle via a static
 * `import` of the JSON, so production needs zero configuration and the
 * bundler traces the file into the Netlify function automatically (no
 * runtime `fs` read of a dynamic path). The only knob is an opt-*out*,
 * `DEDUP_ADAPTER=off`, which the deterministic one-hot embedding mock in
 * the E2E specs sets — a real projection would destroy the mock's
 * orthogonality. It is a plain config knob, like `DEDUP_EMBEDDING_MODEL`
 * / `DEDUP_SIMILARITY_THRESHOLD`.
 */
import { readFileSync } from "node:fs";

import bakedAdapter from "./adapter/ingredient-adapter.json" with { type: "json" };

/** Artifact format version. Bump on breaking changes to the shape. */
export const ADAPTER_VERSION = 1 as const;

/**
 * A single matrix, in one of two encodings. `f32-base64` is what the
 * trainer emits (compact, row-major); `rows` is a human-writable
 * fallback used by tests.
 */
export type EncodedMatrix =
  | { encoding: "f32-base64"; data: string }
  | { encoding: "rows"; data: number[][] };

/** Linear artifact: `z = W·x`. `matrix` is row-major `outputDim × inputDim`. */
export type LinearAdapterFile = {
  version: typeof ADAPTER_VERSION;
  kind?: "linear";
  /** Base embedding model the adapter was trained against. */
  baseModel: string;
  /** Expected length of the raw input vector (e.g. 1536). */
  inputDim: number;
  /** Length of the projected vector (rank of the adapter). */
  outputDim: number;
  createdAt: string;
  /**
   * Cosine threshold, in the *projected* space, that best separated the
   * training pairs. `dedup` uses it as the default cutoff when
   * `DEDUP_SIMILARITY_THRESHOLD` is unset.
   */
  recommendedThreshold: number;
  matrix: EncodedMatrix;
};

/**
 * MLP artifact: `z = W₂·relu(W₁·x + b₁)`.
 * `w1` is `hiddenDim × inputDim`, `b1` has length `hiddenDim`, `w2` is
 * `outputDim × hiddenDim`.
 */
export type MlpAdapterFile = {
  version: typeof ADAPTER_VERSION;
  kind: "mlp";
  baseModel: string;
  inputDim: number;
  hiddenDim: number;
  outputDim: number;
  createdAt: string;
  recommendedThreshold: number;
  w1: EncodedMatrix;
  b1: number[];
  w2: EncodedMatrix;
};

/** On-disk artifact, as written by the offline trainer. */
export type IngredientAdapterFile = LinearAdapterFile | MlpAdapterFile;

/** Fields shared by every parsed adapter, regardless of shape. */
type CommonAdapter = {
  baseModel: string;
  inputDim: number;
  outputDim: number;
  recommendedThreshold: number;
};

/** Parsed linear adapter with the matrix decoded to a flat array. */
export type LinearAdapter = CommonAdapter & {
  kind: "linear";
  /** Flat row-major `outputDim × inputDim` weights. */
  weights: Float32Array;
};

/** Parsed MLP adapter with all layers decoded to flat arrays. */
export type MlpAdapter = CommonAdapter & {
  kind: "mlp";
  hiddenDim: number;
  /** Flat row-major `hiddenDim × inputDim`. */
  w1: Float32Array;
  /** Length `hiddenDim`. */
  b1: Float32Array;
  /** Flat row-major `outputDim × hiddenDim`. */
  w2: Float32Array;
};

/** Parsed, ready-to-apply adapter. */
export type IngredientAdapter = LinearAdapter | MlpAdapter;

// ---------------------------------------------------------------------------
// Matrix codec — shared with the offline trainer so the format has a
// single source of truth.
// ---------------------------------------------------------------------------

/** Encode a `rows × cols` matrix as base64 float32 (row-major). */
export function encodeMatrixBase64(rows: number[][]): string {
  const numRows = rows.length;
  const numCols = numRows === 0 ? 0 : rows[0].length;
  const flat = new Float32Array(numRows * numCols);
  for (let o = 0; o < numRows; o++) {
    const row = rows[o];
    if (row.length !== numCols) {
      throw new Error(
        `ragged matrix: row ${o} has length ${row.length}, expected ${numCols}`,
      );
    }
    flat.set(row, o * numCols);
  }
  return Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength).toString(
    "base64",
  );
}

/**
 * Decode an {@link EncodedMatrix} of known shape into a flat row-major
 * `Float32Array` of length `rows × cols`. `label` names the matrix in
 * error messages (e.g. "matrix", "w1", "w2").
 */
function decodeMatrixEnc(
  m: EncodedMatrix,
  rows: number,
  cols: number,
  label: string,
): Float32Array {
  const expected = rows * cols;
  if (m.encoding === "f32-base64") {
    const buf = Buffer.from(m.data, "base64");
    // Copy into a fresh, aligned Float32Array — the base64 buffer's
    // byteOffset isn't guaranteed to be 4-byte aligned.
    if (buf.byteLength !== expected * 4) {
      throw new Error(
        `adapter ${label} size mismatch: got ${buf.byteLength} bytes, ` +
          `expected ${expected * 4} (${rows}×${cols} f32)`,
      );
    }
    const out = new Float32Array(expected);
    for (let i = 0; i < expected; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
  }
  // "rows" encoding.
  const data = m.data;
  if (data.length !== rows) {
    throw new Error(
      `adapter ${label} rows mismatch: got ${data.length}, expected ${rows}`,
    );
  }
  const out = new Float32Array(expected);
  for (let o = 0; o < rows; o++) {
    const row = data[o];
    if (row.length !== cols) {
      throw new Error(
        `adapter ${label} row ${o} length mismatch: got ${row.length}, ` +
          `expected ${cols}`,
      );
    }
    for (let i = 0; i < cols; i++) out[o * cols + i] = row[i];
  }
  return out;
}

function isMlpFile(file: IngredientAdapterFile): file is MlpAdapterFile {
  return file.kind === "mlp" || "w1" in file;
}

function assertPosInt(name: string, value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`invalid adapter ${name}: ${value}`);
  }
}

/** Validate + decode a parsed artifact object into an {@link IngredientAdapter}. */
export function parseAdapter(file: IngredientAdapterFile): IngredientAdapter {
  if (file.version !== ADAPTER_VERSION) {
    throw new Error(
      `unsupported adapter version ${file.version} (expected ${ADAPTER_VERSION})`,
    );
  }
  if (!Number.isFinite(file.recommendedThreshold)) {
    throw new Error(
      `invalid recommendedThreshold: ${file.recommendedThreshold}`,
    );
  }

  if (isMlpFile(file)) {
    assertPosInt("inputDim", file.inputDim);
    assertPosInt("hiddenDim", file.hiddenDim);
    assertPosInt("outputDim", file.outputDim);
    if (!Array.isArray(file.b1) || file.b1.length !== file.hiddenDim) {
      throw new Error(
        `adapter b1 length mismatch: got ${
          Array.isArray(file.b1) ? file.b1.length : typeof file.b1
        }, expected ${file.hiddenDim}`,
      );
    }
    return {
      kind: "mlp",
      baseModel: file.baseModel,
      inputDim: file.inputDim,
      hiddenDim: file.hiddenDim,
      outputDim: file.outputDim,
      recommendedThreshold: file.recommendedThreshold,
      w1: decodeMatrixEnc(file.w1, file.hiddenDim, file.inputDim, "w1"),
      b1: Float32Array.from(file.b1),
      w2: decodeMatrixEnc(file.w2, file.outputDim, file.hiddenDim, "w2"),
    };
  }

  assertPosInt("inputDim", file.inputDim);
  assertPosInt("outputDim", file.outputDim);
  return {
    kind: "linear",
    baseModel: file.baseModel,
    inputDim: file.inputDim,
    outputDim: file.outputDim,
    recommendedThreshold: file.recommendedThreshold,
    weights: decodeMatrixEnc(
      file.matrix,
      file.outputDim,
      file.inputDim,
      "matrix",
    ),
  };
}

/** Read + parse an adapter artifact from disk. Throws on any problem. */
export function loadAdapterFromFile(path: string): IngredientAdapter {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as IngredientAdapterFile;
  return parseAdapter(parsed);
}

// ---------------------------------------------------------------------------
// Projection.
// ---------------------------------------------------------------------------

/**
 * Project a raw embedding through the adapter. Returns a new
 * `outputDim`-length vector (`z = W·x` for linear,
 * `z = W₂·relu(W₁·x + b₁)` for mlp). The result is *not* normalized —
 * callers feed it to a cosine that normalizes anyway.
 *
 * Defensive no-op: if `vec` doesn't match `adapter.inputDim` (e.g. a
 * different embedding model produced a different length), we return the
 * input unchanged rather than throwing, so a stale artifact can never
 * take down finalise.
 */
export function projectVector(
  vec: number[],
  adapter: IngredientAdapter,
): number[] {
  if (vec.length !== adapter.inputDim) return vec;
  return adapter.kind === "mlp"
    ? projectMlp(vec, adapter)
    : projectLinear(vec, adapter);
}

function projectLinear(vec: number[], adapter: LinearAdapter): number[] {
  const { inputDim, outputDim, weights } = adapter;
  const out = new Array<number>(outputDim);
  for (let o = 0; o < outputDim; o++) {
    let sum = 0;
    const base = o * inputDim;
    for (let i = 0; i < inputDim; i++) sum += weights[base + i] * vec[i];
    out[o] = sum;
  }
  return out;
}

function projectMlp(vec: number[], adapter: MlpAdapter): number[] {
  const { inputDim, hiddenDim, outputDim, w1, b1, w2 } = adapter;
  // Hidden layer: h = relu(W1·x + b1).
  const h = new Float64Array(hiddenDim);
  for (let j = 0; j < hiddenDim; j++) {
    let sum = b1[j];
    const base = j * inputDim;
    for (let i = 0; i < inputDim; i++) sum += w1[base + i] * vec[i];
    h[j] = sum > 0 ? sum : 0;
  }
  // Output layer: z = W2·h.
  const out = new Array<number>(outputDim);
  for (let o = 0; o < outputDim; o++) {
    let sum = 0;
    const base = o * hiddenDim;
    for (let j = 0; j < hiddenDim; j++) sum += w2[base + j] * h[j];
    out[o] = sum;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Memoized loader (baked-in artifact).
// ---------------------------------------------------------------------------

let memo: IngredientAdapter | null | undefined;

/**
 * Return the ingredient adapter, or `null` when disabled
 * (`DEDUP_ADAPTER=off`) or when the baked-in artifact fails to parse.
 * Memoized per process — the artifact is immutable at runtime. Parse
 * failures degrade to `null` (raw cosine) rather than throwing.
 */
export function getIngredientAdapter(): IngredientAdapter | null {
  if (memo !== undefined) return memo;
  // Opt-out for environments where the projected space is undesirable —
  // notably the deterministic one-hot embedding mock in the E2E specs,
  // whose orthogonality a real projection would destroy.
  if (process.env.DEDUP_ADAPTER === "off") {
    memo = null;
    return memo;
  }
  try {
    memo = parseAdapter(bakedAdapter as unknown as IngredientAdapterFile);
  } catch (err) {
    console.warn(
      "[adapter] failed to parse baked-in artifact, " +
        "continuing without adapter:",
      err,
    );
    memo = null;
  }
  return memo;
}

/** Clear the memoized adapter (test seam / config reloads). */
export function resetIngredientAdapterCache(): void {
  memo = undefined;
}
