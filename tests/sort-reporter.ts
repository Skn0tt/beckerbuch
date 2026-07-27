import type { Reporter, Suite, TestCase } from "@playwright/test/reporter";

/**
 * Placeholder preprocess reporter: make discovery / scheduling walk tests
 * in `test.id` ascending order.
 *
 * Playwright's public TestRun API can't reorder — only skip/fixme/fail/
 * exclude — so we mutate the live array from `suite.entries()`. File suites
 * are flattened to a sorted test list (no describe.serial / beforeAll in
 * this suite). Expect this policy to change.
 */
export default class SortReporter implements Reporter {
  printsToStdio() {
    return false;
  }

  async preprocess({ suite }: { suite: Suite }) {
    for (const project of suite.suites) {
      for (const file of project.suites) flattenFileSuiteSortedById(file);
      project
        .entries()
        .sort((a, b) => minTestId(a).localeCompare(minTestId(b)));
    }
    suite
      .entries()
      .sort((a, b) => minTestId(a).localeCompare(minTestId(b)));
  }
}

function flattenFileSuiteSortedById(fileSuite: Suite) {
  const tests = [...fileSuite.allTests()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const entries = fileSuite.entries();
  entries.splice(0, entries.length, ...tests);
  for (const test of tests) {
    // Keep parent pointers consistent with the flattened tree.
    (test as { parent: Suite }).parent = fileSuite;
  }
}

function minTestId(entry: TestCase | Suite): string {
  if (entry.type === "test") return entry.id;
  const ids = entry.allTests().map((t) => t.id);
  ids.sort((a, b) => a.localeCompare(b));
  return ids[0] ?? entry.title;
}
