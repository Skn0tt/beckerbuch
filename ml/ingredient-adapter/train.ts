/**
 * Offline trainer for the ingredient embedding adapter.
 *
 *   node ml/ingredient-adapter/train.ts [flags]
 *
 * Learns a map over frozen OpenAI embeddings so that labeled positive
 * ingredient pairs get high cosine and hard negatives stay low, in the
 * *projected* space. Two architectures:
 *   - linear (default): a single low-rank matrix `W` (rank×1536), `z = W·x`.
 *     This is the shipping model — see README.md §"why not the MLP".
 *   - mlp: a two-layer perceptron `z = W₂·relu(W₁·x + b₁)`
 *     (hidden×1536, then rank×hidden). More capacity, but it overfits the
 *     small (~125-pair) dataset and generalizes worse than linear — kept
 *     for experimentation only, NOT for shipping.
 * Emits an artifact consumed by `app/lib/adapter.ts` at inference time.
 *
 * Pipeline: load pairs (dataset.ts) → embed the distinct texts (OpenAI,
 * cached to .cache/) → Adam on a cosine-margin loss → evaluate vs the
 * raw baseline on a held-out split → write the artifact + a recommended
 * threshold.
 *
 * Flags (all optional):
 *   --synthetic           Fabricate embeddings instead of calling OpenAI.
 *                         Self-tests the whole pipeline with no API key.
 *   --arch=linear         Architecture: `linear` (default) or `mlp`.
 *   --rank=64             Output dimensionality (final projected dim).
 *   --hidden=128          Hidden width (mlp only).
 *   --epochs=500          Training epochs (full-batch).
 *   --lr=0.02             Adam learning rate.
 *   --neg-margin=0.2      Push negatives' cosine below this.
 *   --weight-decay=0.01   L2 regularization on the weight matrices.
 *   --val-frac=0.25       Fraction of pairs held out for eval. Use 0 to
 *                         train on ALL pairs (threshold calibrated
 *                         in-sample) — this is how the shipped artifact
 *                         is produced.
 *   --seed=1              RNG seed (shuffle + init) for reproducibility.
 *   --model=text-embedding-3-small   Base embedding model.
 *   --out=app/lib/adapter/ingredient-adapter.json   Artifact path.
 *   --no-cache            Ignore/skip the on-disk embedding cache.
 *
 * Requires an OpenAI key for real runs, read exactly like the app:
 * EMBEDDING_OPENAI_API_KEY (falls back to OPENAI_API_KEY), optionally
 * EMBEDDING_OPENAI_BASE_URL.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_VERSION,
  encodeMatrixBase64,
  type IngredientAdapterFile,
  type MlpAdapterFile,
} from "../../app/lib/adapter.ts";
import { PAIRS, type PairExample } from "./dataset.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------

type Arch = "linear" | "mlp";

type Opts = {
  synthetic: boolean;
  arch: Arch;
  rank: number;
  hidden: number;
  epochs: number;
  lr: number;
  negMargin: number;
  weightDecay: number;
  valFrac: number;
  seed: number;
  model: string;
  out: string;
  noCache: boolean;
};

function parseOpts(argv: string[]): Opts {
  const o: Opts = {
    synthetic: false,
    arch: "linear",
    rank: 64,
    hidden: 128,
    epochs: 500,
    lr: 0.02,
    negMargin: 0.2,
    weightDecay: 0.01,
    valFrac: 0.25,
    seed: 1,
    model: "text-embedding-3-small",
    out: join(HERE, "../../app/lib/adapter/ingredient-adapter.json"),
    noCache: false,
  };
  for (const arg of argv) {
    if (arg === "--synthetic") o.synthetic = true;
    else if (arg === "--no-cache") o.noCache = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "See the header of ml/ingredient-adapter/train.ts for flags.",
      );
      process.exit(0);
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) throw new Error(`unknown flag: ${arg}`);
      const key = arg.slice(2, eq);
      const val = arg.slice(eq + 1);
      switch (key) {
        case "arch": {
          if (val !== "linear" && val !== "mlp") {
            throw new Error(`--arch must be linear|mlp, got ${val}`);
          }
          o.arch = val;
          break;
        }
        case "rank": o.rank = Number(val); break;
        case "hidden": o.hidden = Number(val); break;
        case "epochs": o.epochs = Number(val); break;
        case "lr": o.lr = Number(val); break;
        case "neg-margin": o.negMargin = Number(val); break;
        case "weight-decay": o.weightDecay = Number(val); break;
        case "val-frac": o.valFrac = Number(val); break;
        case "seed": o.seed = Number(val); break;
        case "model": o.model = val; break;
        case "out": o.out = val; break;
        default: throw new Error(`unknown flag: --${key}`);
      }
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// Small utilities: seeded RNG, vector math, text normalization.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample via Box–Muller, driven by a uniform RNG. */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function normalizeInPlace(v: Float64Array): Float64Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Mirrors normalizeForEmbedding in app/lib/embeddings.ts (cache key). */
function normalizeForEmbedding(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Embeddings: real (OpenAI, cached) or synthetic.
// ---------------------------------------------------------------------------

const INPUT_DIM = 1536;

function distinctTexts(pairs: PairExample[]): string[] {
  const set = new Set<string>();
  for (const p of pairs) {
    set.add(normalizeForEmbedding(p.a));
    set.add(normalizeForEmbedding(p.b));
  }
  return [...set];
}

/**
 * Synthetic embeddings for pipeline self-test. Every text gets a
 * "semantic" anchor shared across positive-linked texts plus a large
 * "surface style" component keyed on its token multiset. The style
 * component drags the raw baseline cosine around (a positive pair with
 * different word order looks less similar; some negatives in the same
 * style bucket look more similar), giving the linear adapter a real,
 * learnable structure to correct — so the run demonstrates an actual
 * improvement, not just that the code runs.
 */
function syntheticEmbeddings(
  pairs: PairExample[],
  texts: string[],
  seed: number,
): Map<string, Float64Array> {
  const rng = mulberry32(seed ^ 0x9e3779b9);

  // Union-find over positive pairs → shared semantic component per group.
  const idx = new Map<string, number>();
  texts.forEach((t, i) => idx.set(t, i));
  const parent = texts.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (const p of pairs) {
    if (p.label !== "positive") continue;
    union(idx.get(normalizeForEmbedding(p.a))!, idx.get(normalizeForEmbedding(p.b))!);
  }

  const anchorByRoot = new Map<number, Float64Array>();
  const randUnit = (): Float64Array => {
    const v = new Float64Array(INPUT_DIM);
    for (let i = 0; i < INPUT_DIM; i++) v[i] = gaussian(rng);
    return normalizeInPlace(v);
  };
  const anchorFor = (root: number): Float64Array => {
    let a = anchorByRoot.get(root);
    if (!a) {
      a = randUnit();
      anchorByRoot.set(root, a);
    }
    return a;
  };

  // Style vectors live in a fixed random subspace keyed by the sorted
  // token multiset, so surface form (word order) perturbs the raw space.
  const styleCache = new Map<string, Float64Array>();
  const styleFor = (text: string): Float64Array => {
    const key = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).sort().join(" ");
    let s = styleCache.get(key);
    if (!s) {
      // Seed a per-key RNG so identical token sets share a style.
      let h = 2166136261;
      for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const r = mulberry32(h >>> 0);
      s = new Float64Array(INPUT_DIM);
      for (let i = 0; i < INPUT_DIM; i++) s[i] = gaussian(r);
      normalizeInPlace(s);
      styleCache.set(key, s);
    }
    return s;
  };

  const SEMANTIC_W = 1.0;
  const STYLE_W = 0.9;
  const NOISE_W = 0.05;
  const out = new Map<string, Float64Array>();
  for (const t of texts) {
    const anchor = anchorFor(find(idx.get(t)!));
    const style = styleFor(t);
    const v = new Float64Array(INPUT_DIM);
    for (let i = 0; i < INPUT_DIM; i++) {
      v[i] = SEMANTIC_W * anchor[i] + STYLE_W * style[i] + NOISE_W * gaussian(rng);
    }
    out.set(t, normalizeInPlace(v));
  }
  return out;
}

async function realEmbeddings(
  texts: string[],
  model: string,
  useCache: boolean,
): Promise<Map<string, Float64Array>> {
  const cacheDir = join(HERE, ".cache");
  const cachePath = join(cacheDir, `embeddings-${model}.json`);
  const cache: Record<string, number[]> =
    useCache && existsSync(cachePath)
      ? JSON.parse(readFileSync(cachePath, "utf8"))
      : {};

  const misses = texts.filter((t) => !cache[t]);
  if (misses.length > 0) {
    const apiKey =
      process.env.EMBEDDING_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "no API key: set EMBEDDING_OPENAI_API_KEY (or OPENAI_API_KEY), " +
          "or run with --synthetic",
      );
    }
    // Call the embeddings endpoint directly with fetch — no SDK, so the
    // trainer stays dependency-free (there's no node_modules for `ml/`).
    // Read exactly like the app: pin to OpenAI, bypassing any gateway.
    const baseUrl =
      process.env.EMBEDDING_OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    const BATCH = 512;
    for (let start = 0; start < misses.length; start += BATCH) {
      const batch = misses.slice(start, start + BATCH);
      console.log(
        `  embedding ${start + 1}–${start + batch.length} / ${misses.length}…`,
      );
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: batch }),
      });
      if (!res.ok) {
        throw new Error(
          `embeddings request failed: ${res.status} ${res.statusText}\n` +
            (await res.text()),
        );
      }
      const json = (await res.json()) as {
        data: { index: number; embedding: number[] }[];
      };
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      batch.forEach((t, i) => {
        cache[t] = sorted[i].embedding;
      });
    }
    if (useCache) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(cache));
    }
  }

  const out = new Map<string, Float64Array>();
  for (const t of texts) {
    const arr = cache[t];
    const v = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) v[i] = arr[i];
    out.set(t, normalizeInPlace(v));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model: W is a flat row-major (rank × dim) Float64Array. z = W·x.
// ---------------------------------------------------------------------------

type Sample = { xa: Float64Array; xb: Float64Array; positive: boolean };

function project(W: Float64Array, rank: number, dim: number, x: Float64Array): Float64Array {
  const z = new Float64Array(rank);
  for (let o = 0; o < rank; o++) {
    let s = 0;
    const base = o * dim;
    for (let i = 0; i < dim; i++) s += W[base + i] * x[i];
    z[o] = s;
  }
  return z;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function initW(rank: number, dim: number, seed: number): Float64Array {
  const rng = mulberry32(seed);
  const W = new Float64Array(rank * dim);
  // Random unit-norm rows: a random low-rank projection to start from.
  for (let o = 0; o < rank; o++) {
    let n = 0;
    for (let i = 0; i < dim; i++) {
      const g = gaussian(rng);
      W[o * dim + i] = g;
      n += g * g;
    }
    n = Math.sqrt(n);
    for (let i = 0; i < dim; i++) W[o * dim + i] /= n;
  }
  return W;
}

/** One full-batch step: returns mean loss, updates W and Adam state. */
function trainStep(
  W: Float64Array,
  rank: number,
  dim: number,
  samples: Sample[],
  opts: Opts,
  adam: { m: Float64Array; v: Float64Array; t: number },
): number {
  const grad = new Float64Array(W.length);
  let lossSum = 0;

  for (const s of samples) {
    const za = project(W, rank, dim, s.xa);
    const zb = project(W, rank, dim, s.xb);
    let na = 0;
    let nb = 0;
    for (let o = 0; o < rank; o++) {
      na += za[o] * za[o];
      nb += zb[o] * zb[o];
    }
    na = Math.sqrt(na) || 1e-12;
    nb = Math.sqrt(nb) || 1e-12;
    let dot = 0;
    for (let o = 0; o < rank; o++) dot += (za[o] / na) * (zb[o] / nb);
    const sim = dot; // cosine in projected space

    // dLoss/dSim.
    let dSim: number;
    if (s.positive) {
      lossSum += 1 - sim;
      dSim = -1;
    } else {
      const hinge = Math.max(0, sim - opts.negMargin);
      lossSum += hinge * hinge;
      dSim = 2 * hinge;
    }
    if (dSim === 0) continue;

    // dSim/dza = (ẑb - sim·ẑa)/na ; symmetric for zb.
    for (let o = 0; o < rank; o++) {
      const zahat = za[o] / na;
      const zbhat = zb[o] / nb;
      const dza = (zbhat - sim * zahat) / na;
      const dzb = (zahat - sim * zbhat) / nb;
      const ga = dSim * dza;
      const gb = dSim * dzb;
      const base = o * dim;
      for (let i = 0; i < dim; i++) {
        grad[base + i] += ga * s.xa[i] + gb * s.xb[i];
      }
    }
  }

  const inv = 1 / samples.length;
  // Adam update with decoupled weight decay.
  const { m, v } = adam;
  adam.t += 1;
  const b1 = 0.9;
  const b2 = 0.999;
  const eps = 1e-8;
  const bc1 = 1 - Math.pow(b1, adam.t);
  const bc2 = 1 - Math.pow(b2, adam.t);
  for (let k = 0; k < W.length; k++) {
    const g = grad[k] * inv + opts.weightDecay * W[k];
    m[k] = b1 * m[k] + (1 - b1) * g;
    v[k] = b2 * v[k] + (1 - b2) * g * g;
    const mh = m[k] / bc1;
    const vh = v[k] / bc2;
    W[k] -= opts.lr * (mh / (Math.sqrt(vh) + eps));
  }
  return lossSum * inv;
}

// ---------------------------------------------------------------------------
// MLP model: z = W2 · relu(W1·x + b1).
//   W1 is (hidden × dim), b1 is (hidden), W2 is (out × hidden), all flat
//   row-major Float64Array. Cosine is taken on the output z.
// ---------------------------------------------------------------------------

type MlpParams = {
  w1: Float64Array; // hidden × dim
  b1: Float64Array; // hidden
  w2: Float64Array; // out × hidden
};

type MlpDims = { dim: number; hidden: number; out: number };

function initMlp(dims: MlpDims, seed: number): MlpParams {
  const { dim, hidden, out } = dims;
  const rng = mulberry32(seed);
  // He init on W1 (feeds a ReLU); modest init on W2.
  const w1 = new Float64Array(hidden * dim);
  const s1 = Math.sqrt(2 / dim);
  for (let k = 0; k < w1.length; k++) w1[k] = gaussian(rng) * s1;
  const w2 = new Float64Array(out * hidden);
  const s2 = Math.sqrt(1 / hidden);
  for (let k = 0; k < w2.length; k++) w2[k] = gaussian(rng) * s2;
  const b1 = new Float64Array(hidden); // zeros
  return { w1, b1, w2 };
}

/** Forward pass, returning the hidden activations for reuse in backprop. */
function forwardMlp(
  p: MlpParams,
  dims: MlpDims,
  x: Float64Array,
): { h: Float64Array; z: Float64Array } {
  const { dim, hidden, out } = dims;
  const h = new Float64Array(hidden);
  for (let j = 0; j < hidden; j++) {
    let s = p.b1[j];
    const base = j * dim;
    for (let i = 0; i < dim; i++) s += p.w1[base + i] * x[i];
    h[j] = s > 0 ? s : 0;
  }
  const z = new Float64Array(out);
  for (let o = 0; o < out; o++) {
    let s = 0;
    const base = o * hidden;
    for (let j = 0; j < hidden; j++) s += p.w2[base + j] * h[j];
    z[o] = s;
  }
  return { h, z };
}

function projectMlp(p: MlpParams, dims: MlpDims, x: Float64Array): Float64Array {
  return forwardMlp(p, dims, x).z;
}

/**
 * Gradient of the cosine-margin loss w.r.t. the two projected vectors.
 * Positives: loss = 1 - cos, pull together. Negatives: squared hinge
 * loss = max(0, cos - margin)², push apart. Shared by construction with
 * the linear path's inline math.
 */
function cosineGrad(
  za: Float64Array,
  zb: Float64Array,
  positive: boolean,
  negMargin: number,
): { loss: number; dza: Float64Array; dzb: Float64Array } {
  const n = za.length;
  let na = 0;
  let nb = 0;
  for (let o = 0; o < n; o++) {
    na += za[o] * za[o];
    nb += zb[o] * zb[o];
  }
  na = Math.sqrt(na) || 1e-12;
  nb = Math.sqrt(nb) || 1e-12;
  let sim = 0;
  for (let o = 0; o < n; o++) sim += (za[o] / na) * (zb[o] / nb);

  let loss: number;
  let dSim: number;
  if (positive) {
    loss = 1 - sim;
    dSim = -1;
  } else {
    const hinge = Math.max(0, sim - negMargin);
    loss = hinge * hinge;
    dSim = 2 * hinge;
  }
  const dza = new Float64Array(n);
  const dzb = new Float64Array(n);
  if (dSim !== 0) {
    for (let o = 0; o < n; o++) {
      const zahat = za[o] / na;
      const zbhat = zb[o] / nb;
      dza[o] = dSim * ((zbhat - sim * zahat) / na);
      dzb[o] = dSim * ((zahat - sim * zbhat) / nb);
    }
  }
  return { loss, dza, dzb };
}

type AdamState = { m: Float64Array; v: Float64Array };

function newAdamState(len: number): AdamState {
  return { m: new Float64Array(len), v: new Float64Array(len) };
}

/** In-place Adam step with decoupled weight decay on one param array. */
function applyAdam(
  param: Float64Array,
  grad: Float64Array,
  st: AdamState,
  t: number,
  lr: number,
  weightDecay: number,
  invBatch: number,
): void {
  const b1 = 0.9;
  const b2 = 0.999;
  const eps = 1e-8;
  const bc1 = 1 - Math.pow(b1, t);
  const bc2 = 1 - Math.pow(b2, t);
  for (let k = 0; k < param.length; k++) {
    const g = grad[k] * invBatch + weightDecay * param[k];
    st.m[k] = b1 * st.m[k] + (1 - b1) * g;
    st.v[k] = b2 * st.v[k] + (1 - b2) * g * g;
    const mh = st.m[k] / bc1;
    const vh = st.v[k] / bc2;
    param[k] -= lr * (mh / (Math.sqrt(vh) + eps));
  }
}

type MlpAdam = { t: number; w1: AdamState; b1: AdamState; w2: AdamState };

/** One full-batch MLP step: returns mean loss, updates params + Adam state. */
function trainStepMlp(
  p: MlpParams,
  dims: MlpDims,
  samples: Sample[],
  opts: Opts,
  adam: MlpAdam,
): number {
  const { dim, hidden, out } = dims;
  const gW1 = new Float64Array(p.w1.length);
  const gb1 = new Float64Array(p.b1.length);
  const gW2 = new Float64Array(p.w2.length);
  let lossSum = 0;

  const accumulate = (
    x: Float64Array,
    h: Float64Array,
    dz: Float64Array,
  ) => {
    // Output layer: gW2[o,j] += dz[o]*h[j]; dh[j] = Σ_o dz[o]*w2[o,j].
    const dh = new Float64Array(hidden);
    for (let o = 0; o < out; o++) {
      const dzo = dz[o];
      if (dzo === 0) continue;
      const base = o * hidden;
      for (let j = 0; j < hidden; j++) {
        gW2[base + j] += dzo * h[j];
        dh[j] += dzo * p.w2[base + j];
      }
    }
    // Hidden layer through the ReLU mask (h[j] > 0).
    for (let j = 0; j < hidden; j++) {
      if (h[j] <= 0) continue;
      const dpre = dh[j];
      if (dpre === 0) continue;
      gb1[j] += dpre;
      const base = j * dim;
      for (let i = 0; i < dim; i++) gW1[base + i] += dpre * x[i];
    }
  };

  for (const s of samples) {
    const fa = forwardMlp(p, dims, s.xa);
    const fb = forwardMlp(p, dims, s.xb);
    const { loss, dza, dzb } = cosineGrad(fa.z, fb.z, s.positive, opts.negMargin);
    lossSum += loss;
    accumulate(s.xa, fa.h, dza);
    accumulate(s.xb, fb.h, dzb);
  }

  const inv = 1 / samples.length;
  adam.t += 1;
  applyAdam(p.w1, gW1, adam.w1, adam.t, opts.lr, opts.weightDecay, inv);
  applyAdam(p.b1, gb1, adam.b1, adam.t, opts.lr, 0, inv); // no decay on bias
  applyAdam(p.w2, gW2, adam.w2, adam.t, opts.lr, opts.weightDecay, inv);
  return lossSum * inv;
}

function flatToRows(flat: Float64Array, rows: number, cols: number): number[][] {
  const out: number[][] = [];
  for (let o = 0; o < rows; o++) {
    const row = new Array<number>(cols);
    for (let i = 0; i < cols; i++) row[i] = flat[o * cols + i];
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation.
// ---------------------------------------------------------------------------

type EvalRow = { positive: boolean; baseCos: number; adaptCos: number };

function evaluate(
  projectFn: (x: Float64Array) => Float64Array,
  samples: Sample[],
): EvalRow[] {
  return samples.map((s) => ({
    positive: s.positive,
    baseCos: cosine(s.xa, s.xb),
    adaptCos: cosine(projectFn(s.xa), projectFn(s.xb)),
  }));
}

/** Best split threshold + accuracy for a given cosine accessor. */
function bestThreshold(
  rows: EvalRow[],
  get: (r: EvalRow) => number,
): { threshold: number; accuracy: number; meanPos: number; meanNeg: number } {
  const cands = [
    ...new Set(rows.map(get).flatMap((c) => [c, c + 1e-6])),
  ].sort((a, b) => a - b);
  let best = { threshold: 0.5, accuracy: -1, meanPos: 0, meanNeg: 0 };
  const pos = rows.filter((r) => r.positive);
  const neg = rows.filter((r) => !r.positive);
  const meanPos = pos.reduce((s, r) => s + get(r), 0) / Math.max(1, pos.length);
  const meanNeg = neg.reduce((s, r) => s + get(r), 0) / Math.max(1, neg.length);
  for (const t of cands) {
    let correct = 0;
    for (const r of rows) {
      const c = get(r);
      if (r.positive ? c >= t : c < t) correct++;
    }
    const accuracy = correct / rows.length;
    // Prefer higher accuracy; tie-break toward a higher (more precise)
    // threshold.
    if (accuracy > best.accuracy || (accuracy === best.accuracy && t > best.threshold)) {
      best = { threshold: t, accuracy, meanPos, meanNeg };
    }
  }
  return best;
}

function fmt(n: number): string {
  return n.toFixed(3);
}

// ---------------------------------------------------------------------------
// Split.
// ---------------------------------------------------------------------------

function stratifiedSplit(
  pairs: PairExample[],
  valFrac: number,
  seed: number,
): { train: PairExample[]; val: PairExample[] } {
  const rng = mulberry32(seed ^ 0x1234);
  const shuffle = (arr: PairExample[]) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  // val-frac 0 (or below): keep every pair in train, hold nothing out.
  // main() then calibrates the threshold in-sample — the shipping path.
  if (valFrac <= 0) {
    return { train: shuffle(pairs), val: [] };
  }
  const pos = shuffle(pairs.filter((p) => p.label === "positive"));
  const neg = shuffle(pairs.filter((p) => p.label === "negative"));
  const cut = (arr: PairExample[]) => Math.max(1, Math.round(arr.length * valFrac));
  const val = [...pos.slice(0, cut(pos)), ...neg.slice(0, cut(neg))];
  const train = [...pos.slice(cut(pos)), ...neg.slice(cut(neg))];
  return { train, val };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseOpts(process.argv.slice(2));
  console.log("ingredient-adapter trainer");
  console.log(
    `  mode=${opts.synthetic ? "synthetic" : "openai"} model=${opts.model} ` +
      `arch=${opts.arch} rank=${opts.rank} hidden=${opts.hidden} ` +
      `epochs=${opts.epochs} lr=${opts.lr} ` +
      `neg-margin=${opts.negMargin} wd=${opts.weightDecay} seed=${opts.seed}`,
  );

  const texts = distinctTexts(PAIRS);
  console.log(`  ${PAIRS.length} pairs, ${texts.length} distinct texts`);

  const emb = opts.synthetic
    ? syntheticEmbeddings(PAIRS, texts, opts.seed)
    : await realEmbeddings(texts, opts.model, !opts.noCache);

  const dim = emb.get(texts[0])!.length;
  if (dim !== INPUT_DIM) {
    console.warn(`  note: embedding dim is ${dim} (expected ${INPUT_DIM})`);
  }

  const toSample = (p: PairExample): Sample => ({
    xa: emb.get(normalizeForEmbedding(p.a))!,
    xb: emb.get(normalizeForEmbedding(p.b))!,
    positive: p.label === "positive",
  });

  const { train, val } = stratifiedSplit(PAIRS, opts.valFrac, opts.seed);
  const trainSamples = train.map(toSample);
  const valSamples = val.map(toSample);
  console.log(`  split: ${train.length} train / ${val.length} val`);

  // With no held-out split (val-frac 0) we evaluate + calibrate the
  // threshold in-sample on the full training set. Honest generalization is
  // reported separately by the CV harness; the shipped weights should use
  // every labeled pair.
  const inSample = val.length === 0;
  const evalPairs = inSample ? train : val;
  const evalSamples = inSample ? trainSamples : valSamples;

  const rank = Math.min(opts.rank, dim);
  const dims: MlpDims = { dim, hidden: Math.min(opts.hidden, dim), out: rank };

  // Train the chosen architecture, exposing a uniform projection closure
  // for eval and a deferred artifact builder (needs `recommended` below).
  let projectFn: (x: Float64Array) => Float64Array;
  let buildArtifact: () => IngredientAdapterFile;

  if (opts.arch === "mlp") {
    const p = initMlp(dims, opts.seed);
    const adam: MlpAdam = {
      t: 0,
      w1: newAdamState(p.w1.length),
      b1: newAdamState(p.b1.length),
      w2: newAdamState(p.w2.length),
    };
    for (let epoch = 1; epoch <= opts.epochs; epoch++) {
      const loss = trainStepMlp(p, dims, trainSamples, opts, adam);
      if (epoch === 1 || epoch % 50 === 0 || epoch === opts.epochs) {
        console.log(`  epoch ${epoch}/${opts.epochs}  train-loss ${fmt(loss)}`);
      }
    }
    projectFn = (x) => projectMlp(p, dims, x);
    buildArtifact = (): MlpAdapterFile => ({
      version: ADAPTER_VERSION,
      kind: "mlp",
      baseModel: opts.model,
      inputDim: dim,
      hiddenDim: dims.hidden,
      outputDim: dims.out,
      createdAt: new Date().toISOString(),
      recommendedThreshold: recommended,
      w1: {
        encoding: "f32-base64",
        data: encodeMatrixBase64(flatToRows(p.w1, dims.hidden, dim)),
      },
      b1: Array.from(p.b1),
      w2: {
        encoding: "f32-base64",
        data: encodeMatrixBase64(flatToRows(p.w2, dims.out, dims.hidden)),
      },
    });
  } else {
    const W = initW(rank, dim, opts.seed);
    const adam = {
      m: new Float64Array(W.length),
      v: new Float64Array(W.length),
      t: 0,
    };
    for (let epoch = 1; epoch <= opts.epochs; epoch++) {
      const loss = trainStep(W, rank, dim, trainSamples, opts, adam);
      if (epoch === 1 || epoch % 50 === 0 || epoch === opts.epochs) {
        console.log(`  epoch ${epoch}/${opts.epochs}  train-loss ${fmt(loss)}`);
      }
    }
    projectFn = (x) => project(W, rank, dim, x);
    buildArtifact = (): IngredientAdapterFile => ({
      version: ADAPTER_VERSION,
      baseModel: opts.model,
      inputDim: dim,
      outputDim: rank,
      createdAt: new Date().toISOString(),
      recommendedThreshold: recommended,
      matrix: {
        encoding: "f32-base64",
        data: encodeMatrixBase64(flatToRows(W, rank, dim)),
      },
    });
  }

  // --- Evaluate on the held-out split (or in-sample when val-frac 0) ---
  const rows = evaluate(projectFn, evalSamples);
  const base = bestThreshold(rows, (r) => r.baseCos);
  const adapt = bestThreshold(rows, (r) => r.adaptCos);

  const evalLabel = inSample ? "in-sample (all pairs)" : "held-out (val)";
  console.log(`\n=== ${evalLabel} eval ===`);
  console.log("             mean-pos  mean-neg   gap   best-thr  accuracy");
  console.log(
    `  baseline    ${fmt(base.meanPos)}     ${fmt(base.meanNeg)}   ` +
      `${fmt(base.meanPos - base.meanNeg)}   ${fmt(base.threshold)}     ${fmt(base.accuracy)}`,
  );
  console.log(
    `  +adapter    ${fmt(adapt.meanPos)}     ${fmt(adapt.meanNeg)}   ` +
      `${fmt(adapt.meanPos - adapt.meanNeg)}   ${fmt(adapt.threshold)}     ${fmt(adapt.accuracy)}`,
  );
  console.log(`\n  per-pair (${inSample ? "all" : "val"}):`);
  evalPairs.forEach((p, i) => {
    const r = rows[i];
    console.log(
      `    [${p.label === "positive" ? "+" : "-"}] base ${fmt(r.baseCos)} → ` +
        `adapt ${fmt(r.adaptCos)}   ${p.a}  ⇔  ${p.b}`,
    );
  });

  // --- Recommended threshold: from the projected-space sweep, nudged to
  // the midpoint between the class means for a little margin. ---
  const recommended = Number(
    Math.min(adapt.threshold, (adapt.meanPos + adapt.meanNeg) / 2).toFixed(4),
  );

  // --- Export artifact ---
  const artifact = buildArtifact();
  if (opts.synthetic) {
    (artifact as Record<string, unknown>).synthetic = true;
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(artifact, null, 0));
  const bytes = readFileSync(opts.out).byteLength;
  const shape =
    opts.arch === "mlp"
      ? `mlp ${dim}→${dims.hidden}→${dims.out}`
      : `linear ${rank}×${dim}`;
  console.log(
    `\nwrote ${opts.out}  (${(bytes / 1024).toFixed(0)} KB, ` +
      `${shape}, recommendedThreshold ${recommended})`,
  );

  if (opts.synthetic) {
    console.log(
      "\n⚠  synthetic artifact — for pipeline testing only, DO NOT ship it.",
    );
  } else {
    console.log("\nNext steps:");
    console.log(`  1. Sanity-check the eval table above (adapter should beat baseline).`);
    console.log(`  2. Commit ${opts.out} — the app statically imports it, so it`);
    console.log(`     ships with the next build. No env var to set; the adapter`);
    console.log(`     is always on (opt out with DEDUP_ADAPTER=off; override the`);
    console.log(`     cutoff with DEDUP_SIMILARITY_THRESHOLD if needed).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
