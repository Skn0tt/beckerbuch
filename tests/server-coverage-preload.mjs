// Test-only preload for the per-worker react-router-serve process.
// Requires NODE_V8_COVERAGE. On SIGUSR2, flush V8 coverage to disk
// (which also resets counters) and print a stable ack line so the
// Playwright fixture can wait for the write.

import v8 from "node:v8";

const ACK = "__COVERAGE_DUMPED__";

process.on("SIGUSR2", () => {
  try {
    v8.takeCoverage();
  } catch (err) {
    console.error("[server-coverage] takeCoverage failed:", err);
  }
  console.log(ACK);
});
