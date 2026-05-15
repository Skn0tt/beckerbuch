import { test as base } from "@playwright/test";
import { createTenant, type Tenant } from "./tenant";

export type Fixtures = {
  tenant: Tenant;
};

export const test = base.extend<Fixtures>({
  tenant: async ({}, use) => {
    const tenant = await createTenant();
    await use(tenant);
  },
});

export { expect } from "@playwright/test";

