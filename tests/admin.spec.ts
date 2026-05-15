import { test, expect } from "./fixtures";

const ADMIN_TOKEN = "test-admin-token";

test("admin/tenants rejects missing token with 401", async ({ request }) => {
  const res = await request.post("/admin/tenants", {
    data: {},
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status()).toBe(401);
});

test("admin/tenants rejects wrong token with 401", async ({ request }) => {
  const res = await request.post("/admin/tenants", {
    data: {},
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": "wrong-token",
    },
  });
  expect(res.status()).toBe(401);
});

test("admin/tenants returns a working invite URL", async ({ request }) => {
  const res = await request.post("/admin/tenants", {
    data: {},
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": ADMIN_TOKEN,
    },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { inviteUrl: string; flat: { id: string } };
  expect(body.inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);
  expect(body.flat.id).toMatch(/^[0-9a-f-]{36}$/);
});
