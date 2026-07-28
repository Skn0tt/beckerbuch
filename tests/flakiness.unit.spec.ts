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
  test("stable all-pass is not flaky", () => {
    const s = flakeScoreFromCounts({ passes: 5, fails: 0, flips: 0 });
    expect(s.flaky).toBe(false);
    expect(s.flakeScore).toBe(0);
    expect(s.flipRate).toBe(0);
  });

  test("single failure among passes scores flip rate not fail share", () => {
    // 10 outcomes, 1 status change → flipRate 1/9
    const s = flakeScoreFromCounts({
      passes: 9,
      fails: 1,
      flips: 1,
      attempts: 10,
    });
    expect(s.flaky).toBe(true);
    expect(s.failRate).toBeCloseTo(0.1);
    expect(s.flipRate).toBeCloseTo(1 / 9);
    expect(s.flakeScore).toBeCloseTo(1 / 9);
  });

  test("alternating outcomes score high flip rate", () => {
    // P F P F → 3 flips over 3 transitions
    const s = flakeScoreFromCounts({
      passes: 2,
      fails: 2,
      flips: 3,
      attempts: 4,
    });
    expect(s.flaky).toBe(true);
    expect(s.flipRate).toBe(1);
    expect(s.flakeScore).toBe(1);
  });

  test("always-red (no passes) is not flaky", () => {
    const s = flakeScoreFromCounts({
      passes: 0,
      fails: 3,
      flips: 0,
      attempts: 3,
    });
    expect(s.flaky).toBe(false);
    expect(s.flakeScore).toBe(0);
    expect(s.flipRate).toBe(0);
  });

  test("flakeDensityWeight leaves residual at max flake", () => {
    expect(flakeDensityWeight(0)).toBe(1);
    expect(flakeDensityWeight(1)).toBeCloseTo(1 - FLAKE_PENALTY);
    expect(flakeDensityWeight(0.5)).toBeCloseTo(1 - 0.5 * FLAKE_PENALTY);
  });
});
