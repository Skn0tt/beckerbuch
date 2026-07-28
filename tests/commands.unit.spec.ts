/**
 * Unit tests for sieve Playwright command builders.
 */
import { test, expect } from "@playwright/test";
import {
  playwrightShardCommand,
  REPORTER_PATH,
  shellQuote,
} from "../sieve/src/commands.ts";
import { TEST_IDS_ENV } from "../sieve/src/protocol.ts";

test.describe("playwrightShardCommand", () => {
  test("includes SIEVE_TEST_IDS, optional files, workers, reporter", () => {
    const cmd = playwrightShardCommand(
      ["id-a", "id-b"],
      4,
      ["tests/a.spec.ts", "tests/b.spec.ts"],
    );
    expect(cmd.startsWith(`${TEST_IDS_ENV}=`)).toBe(true);
    expect(cmd).toContain(shellQuote(JSON.stringify(["id-a", "id-b"])));
    expect(cmd).toContain(shellQuote("tests/a.spec.ts"));
    expect(cmd).toContain(shellQuote("tests/b.spec.ts"));
    expect(cmd).toContain("--workers=4");
    expect(cmd).toContain(`--reporter=${shellQuote(REPORTER_PATH)}`);
  });
});
