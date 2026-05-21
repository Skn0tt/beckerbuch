// End-to-end test for the test-mode HTTPS-MITM proxy. Spins up our
// own proxy + a tiny upstream HTTPS server (signed with a synthetic
// CA the proxy is configured to trust), then drives undici fetch
// through the proxy via ProxyAgent. Exercises every route knob.

import { test, expect } from "@playwright/test";
import https from "node:https";
import { createCA } from "./proxy/ca";
import { createProxy } from "./proxy/server";
import { ProxyAgent } from "undici";
import forge from "node-forge";

async function startUpstream(ca: Awaited<ReturnType<typeof createCA>>): Promise<{
  url: string;
  close: () => Promise<void>;
  received: Array<{ method: string; url: string; body: string }>;
}> {
  // Mint a leaf cert for "localhost" signed by the provided CA. The
  // proxy will be configured to trust this CA for outbound passthrough.
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  cert.setSubject([{ name: "commonName", value: "localhost" }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
  ]);
  cert.sign(ca.keys.privateKey, forge.md.sha256.create());

  const received: Array<{ method: string; url: string; body: string }> = [];
  const server = https.createServer(
    {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      });
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  return {
    url: `https://localhost:${addr.port}`,
    received,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test.describe("proxy: Playwright-shaped Route API", () => {
  test("fulfill / continue / abort / fetch / passthrough", async () => {
    // Synthetic CA — used to sign the test upstream's cert and handed
    // to the proxy so its outbound dispatcher trusts that upstream.
    const upstreamCa = await createCA();
    const proxy = await createProxy({
      trustedUpstreamCa: upstreamCa.certPem,
    });
    const upstream = await startUpstream(upstreamCa);
    // The proxy's own CA must be trusted by the client; ProxyAgent's
    // requestTls.ca is consulted when undici verifies the synthetic
    // cert the proxy mints for the upstream hostname during MITM.
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      requestTls: { ca: proxy.caCertPem },
    });

    try {
      // 1. fulfill — synthetic response, never hits upstream.
      proxy.route(`${upstream.url}/fulfill`, async (route) => {
        await route.fulfill({ status: 201, json: { who: "mock" } });
      });

      const r1 = await fetch(`${upstream.url}/fulfill`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r1.status).toBe(201);
      expect(await r1.json()).toEqual({ who: "mock" });
      expect(upstream.received.filter((r) => r.url === "/fulfill")).toHaveLength(0);

      // 2. continue — hits upstream, response forwarded as-is.
      proxy.route(`${upstream.url}/continue`, async (route) => {
        await route.continue();
      });
      const r2 = await fetch(`${upstream.url}/continue`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r2.status).toBe(200);
      expect(await r2.json()).toEqual({ ok: true, path: "/continue" });
      expect(upstream.received.some((r) => r.url === "/continue")).toBe(true);

      // 3. fetch + transform — handler edits upstream response.
      proxy.route(`${upstream.url}/transform`, async (route) => {
        const res = await route.fetch();
        const body = (await res.json()) as Record<string, unknown>;
        await route.fulfill({ json: { ...body, edited: true } });
      });
      const r3 = await fetch(`${upstream.url}/transform`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(await r3.json()).toEqual({ ok: true, path: "/transform", edited: true });

      // 4. abort — socket killed.
      proxy.route(`${upstream.url}/abort`, async (route) => {
        route.abort("blocked");
      });
      await expect(
        fetch(`${upstream.url}/abort`, {
          dispatcher,
        } as RequestInit & { dispatcher: unknown }),
      ).rejects.toThrow();

      // 5. passthrough — no matching route, default behavior.
      const r5 = await fetch(`${upstream.url}/unmocked`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r5.status).toBe(200);
      expect(await r5.json()).toEqual({ ok: true, path: "/unmocked" });

      // 6. Request body round-trips into the handler.
      proxy.route(`${upstream.url}/echo`, async (route) => {
        const body = await route.request().json();
        await route.fulfill({ json: { echoed: body } });
      });
      const r6 = await fetch(`${upstream.url}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1, b: "two" }),
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(await r6.json()).toEqual({ echoed: { a: 1, b: "two" } });
    } finally {
      await dispatcher.close();
      await upstream.close();
      await proxy.close();
      await upstreamCa.cleanup();
    }
  });

  test("ca cert is written to disk for NODE_EXTRA_CA_CERTS", async () => {
    const ca = await createCA();
    expect(ca.certPath).toMatch(/cookbook-proxy-ca-.+\/ca\.pem$/);
    await ca.cleanup();
  });
});
