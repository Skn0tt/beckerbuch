import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { flatMembers, flats, users } from "../app/db/schema";

export const TEST_PASSWORD = "cookbook-test-password";

// argon2 is ~100ms; hash once and reuse — the salt is embedded in the
// returned string so every test that uses TEST_PASSWORD can share it.
const passwordHashPromise = argon2.hash(TEST_PASSWORD, {
  type: argon2.argon2id,
});

export type TestUser = {
  id: string;
  email: string;
  password: string;
  displayName: string;
};

export type TestFlat = {
  id: string;
  name: string;
};

export type Tenant = {
  user: TestUser;
  flat: TestFlat;
};

/**
 * Provision a fresh user + flat for one test. Each test gets its own
 * tenant, so tests are isolated by multi-tenancy rather than by
 * truncating tables — no global reset needed.
 */
export async function createTenant(): Promise<Tenant> {
  const d = db();
  const slug = randomUUID();
  const email = `test-${slug}@cookbook.test`;
  const displayName = `Test Cook ${slug.slice(0, 8)}`;
  const flatName = `Test Flat ${slug.slice(0, 8)}`;
  const passwordHash = await passwordHashPromise;

  const [user] = await d
    .insert(users)
    .values({ email, passwordHash, displayName })
    .returning({ id: users.id });

  const [flat] = await d
    .insert(flats)
    .values({ name: flatName })
    .returning({ id: flats.id });

  await d.insert(flatMembers).values({ flatId: flat.id, userId: user.id });

  return {
    user: { id: user.id, email, password: TEST_PASSWORD, displayName },
    flat: { id: flat.id, name: flatName },
  };
}
