// Playwright fixtures: worker-scoped mockttp boot + test-scoped reset.
//
// Tests interact with `mocks`, which is the raw `Mockttp` instance.
// On teardown the test fixture calls `server.reset()` so the next
// test starts with no rules and no remembered requests.

import { test as base } from "@playwright/test";
import type { Mockttp } from "mockttp";

import { createProxy, type MockttpHandle } from "./proxy";

export type MockttpWorkerFixtures = {
  /**
   * One mockttp server per worker. Other worker fixtures (e.g. a dev
   * server) consume `workerProxy.env` to route their child process's
   * HTTP through us.
   */
  workerProxy: MockttpHandle;
};

export type MockttpTestFixtures = {
  /**
   * Opt-in handle to the worker's mockttp instance. Asking for this
   * means: "I will declare rules and/or subscribe to events." On
   * teardown we call `server.reset()` so the next test sees no rules
   * or pending requests. Tests that don't list `mocks` skip the reset
   * cost.
   */
  mocks: Mockttp;
};

export const test = base.extend<MockttpTestFixtures, MockttpWorkerFixtures>({
  workerProxy: [
    async ({}, use) => {
      const proxy = await createProxy();
      await use(proxy);
      await proxy.close();
    },
    { scope: "worker" },
  ],

  mocks: async ({ workerProxy }, use) => {
    await use(workerProxy.server);
    // reset() drops all rules + the seen-request log. The
    // passthrough default is re-installed because reset() removes it
    // along with everything else.
    await workerProxy.server.reset();
    await workerProxy.server.forUnmatchedRequest().thenPassThrough();
  },
});
