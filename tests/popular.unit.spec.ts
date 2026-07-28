/**
 * Unit tests for sieve popular helpers.
 */
import { test, expect } from "@playwright/test";
import {
  popularFromCounts,
  POPULAR_BOOST,
} from "../sieve/src/popular.ts";

test.describe("popular", () => {
  test("never-failed is not popular", () => {
    const s = popularFromCounts({ fails: 0, attempts: 5 });
    expect(s.popular).toBe(false);
    expect(s.fails).toBe(0);
  });

  test("any failure marks popular", () => {
    const s = popularFromCounts({ fails: 1, attempts: 11 });
    expect(s.popular).toBe(true);
    expect(s.fails).toBe(1);
  });

  test("corpus flakes are not popular", () => {
    const s = popularFromCounts({ fails: 4, attempts: 10, flaky: true });
    expect(s.popular).toBe(false);
    expect(s.fails).toBe(4);
  });

  test("POPULAR_BOOST is strong", () => {
    expect(POPULAR_BOOST).toBe(10);
  });
});
