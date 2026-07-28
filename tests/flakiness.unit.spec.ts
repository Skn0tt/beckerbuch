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
    const s = flakeScoreFromCounts({ passes: 5, fails: 0 });
    expect(s.flaky).toBe(false);
    expect(s.flakeScore).toBe(0);
    expect(s.failRate).toBe(0);
  });

  test("single failure among passes is flaky and scores fail share", () => {
    const s = flakeScoreFromCounts({ passes: 9, fails: 1 });
    expect(s.flaky).toBe(true);
    expect(s.failRate).toBeCloseTo(0.1);
    expect(s.flakeScore).toBeCloseTo(0.1);
  });

  test("balanced flips score mid fail rate", () => {
    const s = flakeScoreFromCounts({ passes: 2, fails: 2 });
    expect(s.flaky).toBe(true);
    expect(s.failRate).toBeCloseTo(0.5);
    expect(s.flakeScore).toBeCloseTo(0.5);
  });

  test("always-red (no passes) is not flaky", () => {
    const s = flakeScoreFromCounts({ passes: 0, fails: 3 });
    expect(s.flaky).toBe(false);
    expect(s.flakeScore).toBe(0);
    expect(s.failRate).toBe(1);
  });

  test("flakeDensityWeight leaves residual at max flake", () => {
    expect(flakeDensityWeight(0)).toBe(1);
    expect(flakeDensityWeight(1)).toBeCloseTo(1 - FLAKE_PENALTY);
    expect(flakeDensityWeight(0.5)).toBeCloseTo(1 - 0.5 * FLAKE_PENALTY);
  });
});
