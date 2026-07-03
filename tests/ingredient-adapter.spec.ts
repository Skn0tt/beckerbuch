// Pure plumbing tests for the ingredient embedding adapter: matrix
// codec (both encodings), projection matmul, dim-mismatch no-op, and the
// env-gated loader. These exercise app/lib/adapter.ts in isolation — no
// container, no server, no OpenAI — so they use bare `@playwright/test`
// rather than ./fixtures.
import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADAPTER_VERSION,
  encodeMatrixBase64,
  parseAdapter,
  projectVector,
  loadAdapterFromFile,
  getIngredientAdapter,
  resetIngredientAdapterCache,
  type IngredientAdapterFile,
  type LinearAdapterFile,
  type MlpAdapterFile,
} from "../app/lib/adapter";

const rowsFile = (rows: number[][]): LinearAdapterFile => ({
  version: ADAPTER_VERSION,
  baseModel: "test",
  inputDim: rows[0].length,
  outputDim: rows.length,
  createdAt: "2024-01-01T00:00:00.000Z",
  recommendedThreshold: 0.5,
  matrix: { encoding: "rows", data: rows },
});

const mlpFile = (
  w1: number[][],
  b1: number[],
  w2: number[][],
): MlpAdapterFile => ({
  version: ADAPTER_VERSION,
  kind: "mlp",
  baseModel: "test",
  inputDim: w1[0].length,
  hiddenDim: w1.length,
  outputDim: w2.length,
  createdAt: "2024-01-01T00:00:00.000Z",
  recommendedThreshold: 0.5,
  w1: { encoding: "rows", data: w1 },
  b1,
  w2: { encoding: "rows", data: w2 },
});

test.describe("ingredient adapter", () => {
  test.afterEach(() => {
    delete process.env.DEDUP_ADAPTER;
    resetIngredientAdapterCache();
  });

  test("projects via matrix multiply (rows encoding)", () => {
    // W = [[1,0,2],[0,3,0]]; W·[1,1,1] = [3, 3]
    const adapter = parseAdapter(rowsFile([[1, 0, 2], [0, 3, 0]]));
    expect(projectVector([1, 1, 1], adapter)).toEqual([3, 3]);
    expect(projectVector([2, 5, 1], adapter)).toEqual([4, 15]);
  });

  test("f32-base64 encoding round-trips to the same projection", () => {
    const rows = [
      [0.5, -1, 2.25],
      [1, 0, 0],
      [-0.5, 0.5, 1],
    ];
    const file: IngredientAdapterFile = {
      ...rowsFile(rows),
      matrix: { encoding: "f32-base64", data: encodeMatrixBase64(rows) },
    };
    const fromB64 = parseAdapter(file);
    const fromRows = parseAdapter(rowsFile(rows));
    const x = [3, 1, 2];
    // float32 precision — compare with a tolerance.
    const a = projectVector(x, fromB64);
    const b = projectVector(x, fromRows);
    expect(a).toHaveLength(b.length);
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5));
  });

  test("returns the input unchanged on dimension mismatch", () => {
    const adapter = parseAdapter(rowsFile([[1, 0, 0], [0, 1, 0]]));
    const wrong = [1, 2, 3, 4]; // inputDim is 3
    expect(projectVector(wrong, adapter)).toBe(wrong);
  });

  test("parseAdapter rejects a bad version", () => {
    const bad = { ...rowsFile([[1]]), version: 999 } as unknown as IngredientAdapterFile;
    expect(() => parseAdapter(bad)).toThrow(/version/);
  });

  test("parseAdapter rejects a size mismatch", () => {
    const bad: IngredientAdapterFile = {
      ...rowsFile([[1, 2, 3]]),
      outputDim: 2, // claims 2 rows but only 1 provided
    };
    expect(() => parseAdapter(bad)).toThrow(/rows mismatch/);
  });

  test("getIngredientAdapter returns the baked-in adapter by default", () => {
    delete process.env.DEDUP_ADAPTER;
    resetIngredientAdapterCache();
    const a = getIngredientAdapter();
    expect(a).not.toBeNull();
    // Shipping artifact: rank-64 linear adapter over 1536-dim input.
    expect(a!.inputDim).toBe(1536);
    expect(a!.outputDim).toBe(64);
    // memoized: same instance on the second call.
    expect(getIngredientAdapter()).toBe(a);
  });

  test("getIngredientAdapter is null when DEDUP_ADAPTER=off", () => {
    process.env.DEDUP_ADAPTER = "off";
    resetIngredientAdapterCache();
    expect(getIngredientAdapter()).toBeNull();
  });

  test("loadAdapterFromFile throws when the file is missing", () => {
    expect(() =>
      loadAdapterFromFile(join(tmpdir(), "does-not-exist-xyz.json")),
    ).toThrow();
  });

  test("loadAdapterFromFile reads a written artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "adapter-test-"));
    const path = join(dir, "a.json");
    writeFileSync(path, JSON.stringify(rowsFile([[1, 1, 1]])));
    try {
      const a = loadAdapterFromFile(path);
      expect(a.inputDim).toBe(3);
      expect(a.outputDim).toBe(1);
      expect(projectVector([2, 3, 4], a)).toEqual([9]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- MLP artifact format (kind: "mlp") ------------------------------------

  test("projects through the MLP (relu masks a hidden unit, bias applied)", () => {
    // h = relu(W1·x + b1); z = W2·h.
    // x=[1,-2,5], W1=[[1,0,0],[0,1,0]], b1=[0,0.5]
    //   pre = [1, -1.5] → relu → h = [1, 0]  (2nd unit clamped)
    // W2=[[2,3],[1,4]] → z = [2, 1]
    const adapter = parseAdapter(
      mlpFile([[1, 0, 0], [0, 1, 0]], [0, 0.5], [[2, 3], [1, 4]]),
    );
    expect(adapter.kind).toBe("mlp");
    expect(projectVector([1, -2, 5], adapter)).toEqual([2, 1]);
  });

  test("MLP f32-base64 weights round-trip to the same projection", () => {
    const w1 = [[0.5, -1, 2.25], [1, 0, -0.5]];
    const b1 = [0.25, -0.75];
    const w2 = [[1, 2], [-1, 0.5], [0.5, 0.5]];
    const fromRows = parseAdapter(mlpFile(w1, b1, w2));
    const fromB64 = parseAdapter({
      ...mlpFile(w1, b1, w2),
      w1: { encoding: "f32-base64", data: encodeMatrixBase64(w1) },
      w2: { encoding: "f32-base64", data: encodeMatrixBase64(w2) },
    } as IngredientAdapterFile);
    const x = [3, 1, 2];
    const a = projectVector(x, fromB64);
    const b = projectVector(x, fromRows);
    expect(a).toHaveLength(b.length);
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5));
  });

  test("parseAdapter rejects an MLP b1 length mismatch", () => {
    const bad = {
      ...mlpFile([[1, 0, 0], [0, 1, 0]], [0], [[1, 0], [0, 1]]), // b1 too short
    } as IngredientAdapterFile;
    expect(() => parseAdapter(bad)).toThrow(/b1 length mismatch/);
  });

  test("parseAdapter rejects an MLP w1 size mismatch", () => {
    const bad = {
      ...mlpFile([[1, 0, 0], [0, 1, 0]], [0, 0], [[1, 0], [0, 1]]),
      hiddenDim: 3, // claims 3 hidden units but w1 has 2 rows
      b1: [0, 0, 0],
    } as IngredientAdapterFile;
    expect(() => parseAdapter(bad)).toThrow(/w1/);
  });
});
