# Ingredient embedding adapter

A small **learned linear adapter** that sits on top of the frozen OpenAI
ingredient embeddings so the shopping-list dedup treats word-order and
German-compound variants of the same ingredient as the same thing —
"Knoblauchzehen" ⇔ "Zehen Knoblauch", "gehackte Tomaten" ⇔ "Tomaten,
gehackt" — while still keeping genuinely different ingredients apart
(Paprika vs Paprikapulver, Zitrone vs Limette).

## Why an adapter?

OpenAI embedding models **can't be fine-tuned**. Instead we freeze the
embeddings and learn a matrix `W` on top: cluster on `z = W·x` (cosine on
the projected vector) rather than on the raw `x`. `W` is trained offline
on the labeled pairs in [`dataset.ts`](./dataset.ts). Inference lives in
[`app/lib/adapter.ts`](../../app/lib/adapter.ts); it's applied *after* the
embedding cache read in `app/lib/dedup.ts`, so `ingredient_embeddings`
keeps storing raw OpenAI vectors and retraining never invalidates the
cache.

- **Input:** full 1536-dim OpenAI vector (unchanged request + cache key).
- **Output:** low-rank projection (default 64). Low rank keeps training
  fast, the artifact small, and regularizes against the small label set.

## Why linear, not an MLP?

We tried a nonlinear MLP adapter (`--arch=mlp`) hoping to separate
near-synonym hard negatives the linear map can't (Zitrone vs
Zitronenschale). It **overfits** the ~125-pair dataset: `W1` alone is
128×1536 ≈ 200k params against 125 labels, so it memorizes the training
fold and generalizes *worse than doing nothing*.

Pooled held-out AUC over 12 random splits (fraction of positive/negative
pairs ranked correctly):

| model                        | held-out AUC |
| ---------------------------- | ------------ |
| no adapter (baseline)        | 0.769        |
| **linear rank64 / wd0.01**   | **0.843**    |
| mlp h128 / wd0.01            | 0.659        |
| mlp h16 / wd0.1              | 0.628        |
| mlp h32 / wd0.1              | 0.583        |

Only the linear adapter beats the baseline; every MLP variant is below
it. This is a model-class verdict (too many params for the data), not a
tuning miss — shrinking the hidden layer / raising weight decay just
collapses the positive and negative means together. **We ship linear.**
The MLP code (trainer + `adapter.ts` inference) is retained for future
experiments if the dataset grows an order of magnitude; the shipping
artifact is linear.

## Run it

The trainer is plain TypeScript, run directly with Node 26's built-in
type stripping — **not** an npm script.

```bash
# Real run — needs an OpenAI key (read like the app):
export EMBEDDING_OPENAI_API_KEY=sk-...      # or OPENAI_API_KEY
node ml/ingredient-adapter/train.ts

# Pipeline self-test with fabricated embeddings, no key required:
node ml/ingredient-adapter/train.ts --synthetic
```

It prints a held-out eval table (baseline vs adapter: mean positive /
negative cosine, gap, best threshold, accuracy) and per-pair cosines, then
writes the artifact to `app/lib/adapter/ingredient-adapter.json`.

Useful flags (see the header of [`train.ts`](./train.ts) for the full
list): `--rank=128` (bigger artifact), `--epochs`, `--lr`,
`--neg-margin`, `--seed`, `--out=<path>`, `--no-cache`. To reproduce the
shipping artifact — trained on **all** pairs with an in-sample threshold —
pass `--val-frac=0`. The MLP experiment is `--arch=mlp --hidden=128`
(overfits; for experimentation only, not for shipping).

Embeddings are cached under `ml/ingredient-adapter/.cache/` (gitignored)
so repeat runs don't re-hit the API.

## Ship it

1. Run the real trainer and eyeball the eval table — `+adapter` should
   beat `baseline` (bigger pos/neg gap) on the held-out split.
2. Commit the produced `app/lib/adapter/ingredient-adapter.json`. That's
   it — the app statically `import`s this file, so the new artifact ships
   with the next build. No env var, no path to configure.

The adapter is **always on** in production: dedup projects vectors through
it and uses the artifact's `recommendedThreshold` as the default cutoff
(override with `DEDUP_SIMILARITY_THRESHOLD` if you want). The only knob is
an opt-*out*, `DEDUP_ADAPTER=off`, which the deterministic-mock E2E specs
set — the mock emits one-hot vectors that a real projection would false-
merge, so **the tests turn the adapter off**, not on.

## Improve it

The dataset is a **seed**. The single best lever is more real data: pull
actual ingredient item texts from prod, add the word-order / compound
variants you see collapsing incorrectly as `positive`, and the near-miss
pairs that wrongly merge as `negative`. Keep it roughly balanced and keep
the hard negatives (base vs processed form) — they're what stops the
adapter from collapsing everything together.

## Artifact size

`rank × 1536 × 4 bytes`, base64'd: rank 256 ≈ 2 MB, rank 128 ≈ 1 MB, rank
64 (the shipped default) ≈ 0.5 MB. If the artifact in git is too much,
train with a smaller `--rank`; quality degrades gracefully.
