// Playwright `test` extension exposing the proxy as fixtures.
//
// Consumers `mergeTests(test as mocksTest, theirAppTest)` to compose
// with their own fixtures. The worker fixture owns proxy lifecycle;
// the test fixture clears routes + listeners on teardown so each test
// starts clean without paying a setup cost.

import { test as base } from "@playwright/test";

import { createProxy, type Proxy } from "./server";

export type MocksWorkerFixtures = {
  /**
   * One MITM proxy per worker. Mostly used by other worker fixtures
   * (e.g. to merge `workerProxy.env` into a dev-server child process);
   * tests should normally ask for `mocks` instead.
   */
  workerProxy: Proxy;
};

export type MocksTestFixtures = {
  /**
   * Opt-in handle to the worker's MITM proxy. Asking for this fixture
   * means: "I will register some mocks." Routes and event listeners
   * registered during the test are cleared on teardown so the next
   * test starts clean. Tests that don't list `mocks` in their args
   * neither reset nor incur any per-test proxy cost.
   *
   * API mirrors Playwright's page.route():
   *   `mocks.route(urlPattern, async route => …)`
   */
  mocks: Proxy;
};

export const test = base.extend<MocksTestFixtures, MocksWorkerFixtures>({
  workerProxy: [
    async ({}, use) => {
      const proxy = await createProxy();
      await use(proxy);
      await proxy.close();
    },
    { scope: "worker" },
  ],

  mocks: async ({ workerProxy }, use) => {
    await use(workerProxy);
    await workerProxy.unrouteAll();
    workerProxy.removeAllListeners();
  },
});
