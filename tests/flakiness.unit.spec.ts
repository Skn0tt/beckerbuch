/**
 * Unit tests for sieve flakiness scoring helpers.
 */
import { test, expect } from "@playwright/test";
import {
  flakeDensityWeight,
  flakeScoreFromCounts,
  FLAKE_PENALTY,
} from "../sieve/src/flakiness.ts";

test.describe("flakiness", () => {
  test("flakeScoreFromCounts is 0 unless both pass and fail exist", () => {
    expect(flakeScoreFromCounts({ passes: 5, fails: 0 }).flaky).toBe(false);
    expect(flakeScoreFromCounts({ passes: 5, fails: 0 }).flakeScore).toBe(0);
    expect(flakeScoreFromCounts({ passes: 0, fails: 3 }).flaky).toBe(false);
    expect(flakeScoreFromCounts({ passes: 0, fails: 3 }).flakeScore).toBe(0);
  });

  test("flakeScoreFromCounts is fail share when mixed", () => {
    const s = flakeScoreFromCounts({ passes: 1, fails: 1, flips: 1 });
    expect(s.flaky).toBe(true);
    expect(s.flakeScore).toBe(0.5);
    expect(
      flakeScoreFromCounts({ passes: 9, fails: 1 }).flakeScore,
    ).toBeCloseTo(0.1);
  });

  test("flakeDensityWeight leaves residual at max flake", () => {
    expect(flakeDensityWeight(0)).toBe(1);
    expect(flakeDensityWeight(1)).toBeCloseTo(1 - FLAKE_PENALTY);
    expect(flakeDensityWeight(0.5)).toBeCloseTo(1 - 0.5 * FLAKE_PENALTY);
  });
});
