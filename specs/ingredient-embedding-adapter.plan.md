# Ingredient Embedding Adapter Test Plan

## Application Overview

The shopping-list dedup (§6.3) clusters ingredients by cosine similarity
over frozen OpenAI embeddings. A general-purpose embedding model puts
German word-order / compound variants of the *same* ingredient too far
apart ("Knoblauchzehen" vs "Zehen Knoblauch"), so a learned **linear
adapter** `W` is applied on top of the frozen vectors — cluster on
`z = W·x` — trained offline on labeled pairs (`ml/ingredient-adapter/`)
and baked into the bundle via a static `import` of the artifact JSON
(always on; opt out with `DEDUP_ADAPTER=off`). Inference lives in
`app/lib/adapter.ts`.

These are pure plumbing tests: the matrix codec, the projection, the
dim-mismatch guard, and the env-gated loader. They run in isolation with
bare `@playwright/test` (no container, server, or OpenAI), because the
adapter module only depends on `node:fs`. End-to-end dedup behaviour with
an adapter active is not covered here — the deterministic-mock harness
emits one-hot vectors that an adapter would falsely merge, which is
exactly why the adapter is off by default.

## Test Scenarios

### 1. Projection

**File:** `tests/ingredient-adapter.spec.ts`

#### 1.1. projects-via-matrix-multiply-rows-encoding

**Steps:**
  1. Parse an adapter with matrix `[[1,0,2],[0,3,0]]` (rows encoding).
    - expect: `projectVector([1,1,1])` equals `[3, 3]`.
    - expect: `projectVector([2,5,1])` equals `[4, 15]`.

#### 1.2. f32-base64-encoding-round-trips-to-the-same-projection

**Steps:**
  1. Encode a matrix via `encodeMatrixBase64`, parse it back, and parse
     the same matrix in rows encoding.
    - expect: both project an input vector to the same result (within
      float32 tolerance).

#### 1.3. returns-the-input-unchanged-on-dimension-mismatch

**Steps:**
  1. Parse an adapter with `inputDim` 3 and project a length-4 vector.
    - expect: the exact input array is returned (identity no-op), so a
      stale artifact from a different model can't break Finalise.

### 2. Artifact validation

**File:** `tests/ingredient-adapter.spec.ts`

#### 2.1. parseAdapter-rejects-a-bad-version

**Steps:**
  1. Parse an artifact with `version: 999`.
    - expect: throws, message mentions `version`.

#### 2.2. parseAdapter-rejects-a-size-mismatch

**Steps:**
  1. Parse an artifact whose `outputDim` (2) exceeds the provided rows (1).
    - expect: throws, message mentions `rows mismatch`.

### 3. Baked-in loader

**File:** `tests/ingredient-adapter.spec.ts`

#### 3.1. getIngredientAdapter-returns-the-baked-in-adapter-by-default

**Steps:**
  1. With `DEDUP_ADAPTER` unset, reset the cache and call
     `getIngredientAdapter()`.
    - expect: a non-null adapter (the shipping rank-64 / 1536-dim
      artifact), memoized across calls.

#### 3.2. getIngredientAdapter-is-null-when-DEDUP_ADAPTER=off

**Steps:**
  1. Set `DEDUP_ADAPTER=off`, reset the cache, and load.
    - expect: returns `null` (raw-cosine behaviour, what the E2E specs
      rely on).

#### 3.3. loadAdapterFromFile-throws-when-the-file-is-missing

**Steps:**
  1. Call `loadAdapterFromFile` on a nonexistent path.
    - expect: throws (the baked-in loader never uses this path, so no
      silent-degrade requirement here).

#### 3.4. loadAdapterFromFile-reads-a-written-artifact

**Steps:**
  1. Write an artifact and load it directly.
    - expect: dims parsed correctly and `projectVector` matches the
      matrix.
