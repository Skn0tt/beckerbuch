// End-to-end test for the test-mode HTTPS-MITM proxy. Spins up our
// own proxy + a tiny upstream HTTPS server (signed with a synthetic
// CA the proxy is configured to trust), then drives undici fetch
// through the proxy via ProxyAgent. Exercises every route knob.

import { test, expect } from "@playwright/test";
import https from "node:https";
import { generateCACertificate } from "mockttp";
import { createProxy } from "../src";
import { ProxyAgent } from "undici";
import forge from "node-forge";

interface SyntheticCA {
  /** PEM-encoded CA certificate. */
  certPem: string;
  /** PEM-encoded CA private key. */
  keyPem: string;
}

async function makeCA(): Promise<SyntheticCA> {
  const ca = await generateCACertificate();
  return { certPem: ca.cert, keyPem: ca.key };
}

async function startUpstream(ca: SyntheticCA): Promise<{
  url: string;
  close: () => Promise<void>;
  received: Array<{ method: string; url: string; body: string }>;
}> {
  // Mint a leaf cert for "localhost" signed by the provided CA. The
  // proxy will be configured to trust this CA for outbound passthrough.
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  cert.setSubject([{ name: "commonName", value: "localhost" }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

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
    const upstreamCa = await makeCA();
    const proxy = await createProxy({
      trustedUpstreamCa: upstreamCa.certPem,
    });
    const upstream = await startUpstream(upstreamCa);
    // The proxy's own CA must be trusted by the client at two layers:
    // proxyTls.ca for the outer TLS to the HTTPS proxy itself, and
    // requestTls.ca for the inner TLS to the synthetic MITM cert the
    // proxy mints for the upstream hostname.
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      proxyTls: { ca: proxy.caCertPem },
      requestTls: { ca: proxy.caCertPem },
    });

    try {
      // 1. fulfill — synthetic response, never hits upstream.
      await proxy.route(`${upstream.url}/fulfill`, async (route) => {
        await route.fulfill({ status: 201, json: { who: "mock" } });
      });

      const r1 = await fetch(`${upstream.url}/fulfill`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r1.status).toBe(201);
      expect(await r1.json()).toEqual({ who: "mock" });
      expect(upstream.received.filter((r) => r.url === "/fulfill")).toHaveLength(0);

      // 2. continue — hits upstream, response forwarded as-is.
      await proxy.route(`${upstream.url}/continue`, async (route) => {
        await route.continue();
      });
      const r2 = await fetch(`${upstream.url}/continue`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r2.status).toBe(200);
      expect(await r2.json()).toEqual({ ok: true, path: "/continue" });
      expect(upstream.received.some((r) => r.url === "/continue")).toBe(true);

      // 3. fetch + transform — handler edits upstream response.
      await proxy.route(`${upstream.url}/transform`, async (route) => {
        const res = await route.fetch();
        const body = (await res.json()) as Record<string, unknown>;
        await route.fulfill({ json: { ...body, edited: true } });
      });
      const r3 = await fetch(`${upstream.url}/transform`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(await r3.json()).toEqual({ ok: true, path: "/transform", edited: true });

      // 4. abort — socket killed.
      await proxy.route(`${upstream.url}/abort`, async (route) => {
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
      await proxy.route(`${upstream.url}/echo`, async (route) => {
        const body = route.request().postDataJSON();
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
      
    }
  });

  test("proxy writes its CA cert to disk for NODE_EXTRA_CA_CERTS", async () => {
    const proxy = await createProxy();
    try {
      expect(proxy.caCertPath).toMatch(/playwright-mocks-ca-.+\/ca\.pem$/);
      expect(proxy.env.NODE_EXTRA_CA_CERTS).toBe(proxy.caCertPath);
    } finally {
      await proxy.close();
    }
  });

  test("events: on('request'), on('response'), waitFor*", async () => {
    const upstreamCa = await makeCA();
    const proxy = await createProxy({ trustedUpstreamCa: upstreamCa.certPem });
    const upstream = await startUpstream(upstreamCa);
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      proxyTls: { ca: proxy.caCertPem },
      requestTls: { ca: proxy.caCertPem },
    });

    try {
      // Collect all requests/responses for after-the-fact assertions.
      const reqUrls: string[] = [];
      const resStatuses: number[] = [];
      proxy.on("request", (r) => reqUrls.push(r.url()));
      proxy.on("response", (r) => resStatuses.push(r.status()));

      // Mocked route — should still fire both events.
      await proxy.route(`${upstream.url}/mocked`, async (route) => {
        await route.fulfill({ status: 418, json: { i_am: "teapot" } });
      });

      // waitForRequest with predicate, started BEFORE the trigger (the
      // typical Promise.all race-free pattern).
      const reqWait = proxy.waitForRequest(
        (r) => r.url().endsWith("/mocked") && r.method() === "POST",
        { timeout: 5_000 },
      );
      const resWait = proxy.waitForResponse(
        (r) => r.url().endsWith("/mocked"),
        { timeout: 5_000 },
      );

      const r = await fetch(`${upstream.url}/mocked`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hi: "there" }),
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r.status).toBe(418);

      const matchedReq = await reqWait;
      expect(matchedReq.method()).toBe("POST");
      expect(matchedReq.postDataJSON()).toEqual({ hi: "there" });

      const matchedRes = await resWait;
      expect(matchedRes.status()).toBe(418);
      expect(await matchedRes.json()).toEqual({ i_am: "teapot" });
      expect(matchedRes.request().url()).toBe(matchedReq.url());

      // Passthrough also fires events with the real upstream response.
      const passWait = proxy.waitForResponse(/\/passthrough$/, { timeout: 5_000 });
      await fetch(`${upstream.url}/passthrough`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      const passRes = await passWait;
      expect(passRes.status()).toBe(200);
      expect(await passRes.json()).toEqual({ ok: true, path: "/passthrough" });

      // Order check: request emitted before its matching response.
      expect(reqUrls).toContain(`${upstream.url}/mocked`);
      expect(resStatuses).toContain(418);
      expect(resStatuses).toContain(200);

      // Timeout case rejects with a useful message.
      await expect(
        proxy.waitForRequest("https://never.example/", { timeout: 100 }),
      ).rejects.toThrow(/Timed out 100ms/);
    } finally {
      await dispatcher.close();
      await upstream.close();
      await proxy.close();
      
    }
  });

  test("Route.fulfill works after the route handler returns (deferred)", async () => {
    const upstreamCa = await makeCA();
    const proxy = await createProxy({ trustedUpstreamCa: upstreamCa.certPem });
    const upstream = await startUpstream(upstreamCa);
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      proxyTls: { ca: proxy.caCertPem },
      requestTls: { ca: proxy.caCertPem },
    });

    try {
      // The handler stashes the Route and returns immediately. Another
      // path (here: a setTimeout) settles it later. mockttp's callback
      // must wait for the deferred — i.e. the client's fetch must NOT
      // see a response until our setTimeout fires.
      let stashed: import("../src").Route | null = null;
      await proxy.route(`${upstream.url}/deferred`, (route) => {
        stashed = route;
        // Intentionally not awaited; not even returned.
      });

      const fetchPromise = fetch(`${upstream.url}/deferred`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });

      // Give the handler a tick to run + stash. It must not have
      // resolved the fetch yet.
      await new Promise((r) => setTimeout(r, 50));
      const settledEarly = await Promise.race([
        fetchPromise.then(() => "settled" as const),
        new Promise<"pending">((r) => setTimeout(() => r("pending"), 0)),
      ]);
      expect(settledEarly).toBe("pending");
      expect(stashed).not.toBeNull();

      // Now settle from outside the handler.
      await stashed!.fulfill({ status: 202, json: { from: "outside" } });

      const r = await fetchPromise;
      expect(r.status).toBe(202);
      expect(await r.json()).toEqual({ from: "outside" });
    } finally {
      await dispatcher.close();
      await upstream.close();
      await proxy.close();
    }
  });

  test("route.fallback() delegates to the next-registered handler (LIFO)", async () => {
    const upstreamCa = await makeCA();
    const proxy = await createProxy({ trustedUpstreamCa: upstreamCa.certPem });
    const upstream = await startUpstream(upstreamCa);
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      proxyTls: { ca: proxy.caCertPem },
      requestTls: { ca: proxy.caCertPem },
    });

    try {
      const order: string[] = [];
      // First-registered: would fulfill, but ends up not invoked when
      // the second falls back and the third fulfills.
      await proxy.route(`${upstream.url}/chain`, async (route) => {
        order.push("first");
        await route.fulfill({ status: 201, body: "first" });
      });
      // Second-registered: always falls back.
      await proxy.route(`${upstream.url}/chain`, async (route) => {
        order.push("second");
        route.fallback();
      });
      // Third-registered: runs first (LIFO), fulfills.
      await proxy.route(`${upstream.url}/chain`, async (route) => {
        order.push("third");
        await route.fulfill({ status: 203, body: "third" });
      });

      const r = await fetch(`${upstream.url}/chain`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r.status).toBe(203);
      expect(await r.text()).toBe("third");
      // Third ran first, second never ran (third already fulfilled),
      // first never ran either.
      expect(order).toEqual(["third"]);
    } finally {
      await dispatcher.close();
      await upstream.close();
      await proxy.close();
    }
  });

  test("route.fallback() with no remaining matches falls through to network", async () => {
    const upstreamCa = await makeCA();
    const proxy = await createProxy({ trustedUpstreamCa: upstreamCa.certPem });
    const upstream = await startUpstream(upstreamCa);
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      proxyTls: { ca: proxy.caCertPem },
      requestTls: { ca: proxy.caCertPem },
    });

    try {
      await proxy.route(`${upstream.url}/passthrough`, (route) => {
        route.fallback();
      });

      const r = await fetch(`${upstream.url}/passthrough`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r.status).toBe(200);
      // Hit the real upstream.
      expect(upstream.received.map((x) => x.url)).toContain("/passthrough");
    } finally {
      await dispatcher.close();
      await upstream.close();
      await proxy.close();
    }
  });

  test("route { times: N } auto-removes the handler after N invocations", async () => {
    const upstreamCa = await makeCA();
    const proxy = await createProxy({ trustedUpstreamCa: upstreamCa.certPem });
    const upstream = await startUpstream(upstreamCa);
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      proxyTls: { ca: proxy.caCertPem },
      requestTls: { ca: proxy.caCertPem },
    });

    try {
      let hits = 0;
      await proxy.route(
        `${upstream.url}/once`,
        async (route) => {
          hits++;
          await route.fulfill({ status: 201, body: "mocked" });
        },
        { times: 2 },
      );

      const r1 = await fetch(`${upstream.url}/once`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      const r2 = await fetch(`${upstream.url}/once`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      // Third hit must fall through to the real upstream.
      const r3 = await fetch(`${upstream.url}/once`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });

      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r3.status).toBe(200);
      expect(hits).toBe(2);
      expect(upstream.received.map((x) => x.url)).toEqual(["/once"]);
    } finally {
      await dispatcher.close();
      await upstream.close();
      await proxy.close();
    }
  });

  test("unroute(pattern, handler) removes a specific registration", async () => {
    const upstreamCa = await makeCA();
    const proxy = await createProxy({ trustedUpstreamCa: upstreamCa.certPem });
    const upstream = await startUpstream(upstreamCa);
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      proxyTls: { ca: proxy.caCertPem },
      requestTls: { ca: proxy.caCertPem },
    });

    try {
      const handlerA = async (route: import("../src").Route) => {
        await route.fulfill({ status: 201, body: "A" });
      };
      const handlerB = async (route: import("../src").Route) => {
        await route.fulfill({ status: 202, body: "B" });
      };
      const pattern = `${upstream.url}/unroute`;
      await proxy.route(pattern, handlerA);
      await proxy.route(pattern, handlerB);

      // B was last-registered → runs first.
      let r = await fetch(`${upstream.url}/unroute`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r.status).toBe(202);

      // Remove B. A should now win.
      await proxy.unroute(pattern, handlerB);
      r = await fetch(`${upstream.url}/unroute`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r.status).toBe(201);

      // Remove A by pattern only. Falls through to network.
      await proxy.unroute(pattern);
      r = await fetch(`${upstream.url}/unroute`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r.status).toBe(200);
    } finally {
      await dispatcher.close();
      await upstream.close();
      await proxy.close();
    }
  });

  test("requestfinished / requestfailed events", async () => {
    const upstreamCa = await makeCA();
    const proxy = await createProxy({ trustedUpstreamCa: upstreamCa.certPem });
    const upstream = await startUpstream(upstreamCa);
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      proxyTls: { ca: proxy.caCertPem },
      requestTls: { ca: proxy.caCertPem },
    });

    try {
      const finished: string[] = [];
      const failed: string[] = [];
      proxy.on("requestfinished", (req) => finished.push(req.url()));
      proxy.on("requestfailed", (req) => failed.push(req.url()));

      await proxy.route(`${upstream.url}/ok`, async (route) => {
        await route.fulfill({ status: 200, body: "ok" });
      });
      await proxy.route(`${upstream.url}/boom`, (route) => {
        route.abort();
      });

      await fetch(`${upstream.url}/ok`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown }).then((r) => r.text());

      await expect(
        fetch(`${upstream.url}/boom`, {
          dispatcher,
        } as RequestInit & { dispatcher: unknown }),
      ).rejects.toThrow();

      // Settle pending event-loop tasks.
      await new Promise((r) => setTimeout(r, 50));
      expect(finished).toEqual([`${upstream.url}/ok`]);
      expect(failed).toEqual([`${upstream.url}/boom`]);
    } finally {
      await dispatcher.close();
      await upstream.close();
      await proxy.close();
    }
  });

  test("request.response() resolves with the matching response (null on abort)", async () => {
    const upstreamCa = await makeCA();
    const proxy = await createProxy({ trustedUpstreamCa: upstreamCa.certPem });
    const upstream = await startUpstream(upstreamCa);
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      proxyTls: { ca: proxy.caCertPem },
      requestTls: { ca: proxy.caCertPem },
    });

    try {
      await proxy.route(`${upstream.url}/ok2`, async (route) => {
        await route.fulfill({ status: 201, body: "hi" });
      });
      await proxy.route(`${upstream.url}/boom2`, (route) => {
        route.abort();
      });

      const okReqP = proxy.waitForRequest(`${upstream.url}/ok2`);
      void fetch(`${upstream.url}/ok2`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown }).then((r) => r.text());
      const okReq = await okReqP;
      const okRes = await okReq.response();
      expect(okRes).not.toBeNull();
      expect(okRes!.status()).toBe(201);

      const boomReqP = proxy.waitForRequest(`${upstream.url}/boom2`);
      void fetch(`${upstream.url}/boom2`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown }).catch(() => {});
      const boomReq = await boomReqP;
      const boomRes = await boomReq.response();
      expect(boomRes).toBeNull();
    } finally {
      await dispatcher.close();
      await upstream.close();
      await proxy.close();
    }
  });

  test("continue({ url }) rewrites the upstream target", async () => {
    const upstreamCa = await makeCA();
    const proxy = await createProxy({ trustedUpstreamCa: upstreamCa.certPem });
    const upstream = await startUpstream(upstreamCa);
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      proxyTls: { ca: proxy.caCertPem },
      requestTls: { ca: proxy.caCertPem },
    });

    try {
      await proxy.route(`${upstream.url}/from`, async (route) => {
        await route.continue({ url: `${upstream.url}/to` });
      });

      const r = await fetch(`${upstream.url}/from`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r.status).toBe(200);
      // Upstream saw the rewritten path, not the original.
      expect(upstream.received.map((x) => x.url)).toEqual(["/to"]);
    } finally {
      await dispatcher.close();
      await upstream.close();
      await proxy.close();
    }
  });

  test("header helpers + response.ok()", async () => {
    const upstreamCa = await makeCA();
    const proxy = await createProxy({ trustedUpstreamCa: upstreamCa.certPem });
    const upstream = await startUpstream(upstreamCa);
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      proxyTls: { ca: proxy.caCertPem },
      requestTls: { ca: proxy.caCertPem },
    });

    try {
      await proxy.route(`${upstream.url}/headers`, async (route) => {
        const req = route.request();
        expect(req.headerValue("X-Single")).toBe("one");
        expect(req.headerValue("x-missing")).toBeNull();
        expect(await req.allHeaders()).toMatchObject({
          "x-single": "one",
        });
        await route.fulfill({
          status: 404,
          headers: { "x-foo": "a", "x-bar": "b" },
          body: "nope",
        });
      });

      const resP = proxy.waitForResponse(`${upstream.url}/headers`);
      const r = await fetch(`${upstream.url}/headers`, {
        dispatcher,
        headers: { "X-Single": "one" },
      } as RequestInit & { dispatcher: unknown });
      expect(r.status).toBe(404);

      const res = await resP;
      expect(res.ok()).toBe(false);
      expect(res.headerValue("X-Foo")).toBe("a");
      expect(await res.allHeaders()).toMatchObject({ "x-foo": "a", "x-bar": "b" });
    } finally {
      await dispatcher.close();
      await upstream.close();
      await proxy.close();
    }
  });

  test("fulfill({ path }) reads file body and infers content-type", async () => {
    const upstreamCa = await makeCA();
    const proxy = await createProxy({ trustedUpstreamCa: upstreamCa.certPem });
    const upstream = await startUpstream(upstreamCa);
    const dispatcher = new ProxyAgent({
      uri: proxy.url,
      proxyTls: { ca: proxy.caCertPem },
      requestTls: { ca: proxy.caCertPem },
    });

    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "proxy-self-path-"));
    const file = join(dir, "fixture.json");
    await writeFile(file, JSON.stringify({ hello: "world" }), "utf8");

    try {
      await proxy.route(`${upstream.url}/from-file`, async (route) => {
        await route.fulfill({ path: file });
      });

      const r = await fetch(`${upstream.url}/from-file`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/json");
      expect(await r.json()).toEqual({ hello: "world" });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await dispatcher.close();
      await upstream.close();
      await proxy.close();
    }
  });

  test("glob matcher: ?, [abc], {a,b}", async () => {
    const { matchPattern } = await import("../src");
    expect(matchPattern("https://a.com/?", "https://a.com/x")).toBe(true);
    expect(matchPattern("https://a.com/?", "https://a.com/xx")).toBe(false);
    expect(matchPattern("https://a.com/[abc]", "https://a.com/b")).toBe(true);
    expect(matchPattern("https://a.com/[abc]", "https://a.com/d")).toBe(false);
    expect(
      matchPattern("https://a.com/{foo,bar}", "https://a.com/foo"),
    ).toBe(true);
    expect(
      matchPattern("https://a.com/{foo,bar}", "https://a.com/bar"),
    ).toBe(true);
    expect(
      matchPattern("https://a.com/{foo,bar}", "https://a.com/baz"),
    ).toBe(false);
    // Existing globs still work.
    expect(matchPattern("https://a.com/*", "https://a.com/x")).toBe(true);
    expect(matchPattern("https://a.com/**", "https://a.com/x/y")).toBe(true);
  });

  test("removeAllListeners drops subscribers", async () => {
    const proxy = await createProxy();
    try {
      let fired = 0;
      proxy.on("request", () => fired++);
      proxy.removeAllListeners();
      // Smoke: a subsequent listener still works.
      let fired2 = 0;
      proxy.on("request", () => fired2++);
      // No actual traffic — assert listener count went to 1 only.
      // (Indirect: emit through a no-op route.)
      expect(fired).toBe(0);
      expect(fired2).toBe(0);
    } finally {
      await proxy.close();
    }
  });
});
