// Test-only preload for the per-worker react-router-serve process.
// Requires NODE_V8_COVERAGE. On SIGUSR2, flush V8 coverage to disk
// (which also resets counters) and print a stable ack line so the
// Playwright fixture can wait for the write. ACK is only emitted on
// success — failure gets a distinct line so the parent doesn't treat
// a failed dump as complete.

import v8 from "node:v8";

const ACK = "__COVERAGE_DUMPED__";
const FAIL = "__COVERAGE_DUMP_FAILED__";

process.on("SIGUSR2", () => {
  try {
    v8.takeCoverage();
    console.log(ACK);
  } catch (err) {
    console.error("[server-coverage] takeCoverage failed:", err);
    console.log(FAIL);
  }
});
