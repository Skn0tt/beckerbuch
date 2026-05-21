// HTTPS-MITM forward proxy. Listens on a random port; the dev server
// reaches it via HTTPS_PROXY. CONNECT requests get a TLS-MITM treatment
// (synthetic cert minted on the fly), then the decrypted bytes are fed
// to an internal http.Server so Node's HTTP parser does the work. Each
// parsed request is matched against the route list (first match wins);
// unmatched requests pass through to the real upstream.

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Agent } from "undici";

import { createCA } from "./ca";
import { CertCache } from "./cert-cache";
import { Route, matchPattern, type RoutePattern, type RouteHandler } from "./route";

interface Registration {
  pattern: RoutePattern;
  handler: RouteHandler;
}

export interface Proxy {
  url: string;
  caCertPath: string;
  /** PEM-encoded CA cert. Tests can sign upstream leaf certs with this. */
  caCertPem: string;
  /** Env block to merge into a child process for HTTPS_PROXY + CA trust. */
  env: NodeJS.ProcessEnv;
  /** Register a route. Last-registered wins (LIFO) so test setup can override worker defaults. */
  route(pattern: RoutePattern, handler: RouteHandler): Promise<void>;
  /** Drop all routes — typically called per-test on teardown. */
  unrouteAll(): void;
  close(): Promise<void>;
}

export interface CreateProxyOptions {
  /**
   * Extra CA PEM(s) to trust when the proxy makes outbound passthrough
   * fetches. Real upstreams use system-trusted certs so this is only
   * useful for tests that spin up their own HTTPS server with a
   * synthetic cert.
   */
  trustedUpstreamCa?: string | string[];
}

export async function createProxy(options: CreateProxyOptions = {}): Promise<Proxy> {
  const ca = await createCA();
  const certs = new CertCache(ca);
  // Most-recent first so test mocks naturally override worker-default ones.
  const routes: Registration[] = [];
  // Outbound dispatcher — must NOT use ProxyAgent (would loop).
  const passthroughDispatcher = options.trustedUpstreamCa
    ? new Agent({ connect: { ca: options.trustedUpstreamCa } })
    : new Agent();

  // Internal http.Server: never listens on a port. We feed it
  // already-decrypted TLS sockets via emit("connection", sock).
  const internal = http.createServer();
  internal.on("request", (req, res) =>
    handleRequest(req, res, routes, "https", passthroughDispatcher),
  );

  const proxy = http.createServer();
  proxy.on("request", (req, res) => {
    // Plain HTTP proxy form: req.url is an absolute URL.
    handleRequest(req, res, routes, "http", passthroughDispatcher);
  });
  proxy.on("connect", (req, clientSocket, head) => {
    const hostPort = req.url ?? "";
    const [host, portStr] = hostPort.split(":");
    if (!host) {
      clientSocket.destroy();
      return;
    }
    clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (head && head.length > 0) clientSocket.unshift(head);

    const tlsSocket = new TLSSocket(clientSocket, {
      isServer: true,
      SNICallback: (servername, cb) => {
        cb(null, certs.get(servername || host));
      },
      // SNI is required by undici, but if the client doesn't send it
      // we still fall back to `host` from CONNECT.
      secureContext: certs.get(host),
    });
    tlsSocket.on("error", () => {
      // Likely a client that didn't trust our CA. Just drop it.
    });
    // Stash the authority so handleRequest can rebuild absolute URLs.
    (tlsSocket as TLSSocketWithHost)._kbAuthority = `${host}:${portStr || "443"}`;
    internal.emit("connection", tlsSocket);
  });

  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") {
    throw new Error("proxy.listen returned no address");
  }
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    caCertPath: ca.certPath,
    caCertPem: ca.certPem,
    env: {
      HTTPS_PROXY: url,
      HTTP_PROXY: url,
      // Without this, Node tunnels localhost traffic through our proxy
      // too — including the vite dev server's SSR-internal fetches and
      // the browser-driven action POSTs that go through it.
      NO_PROXY: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: ca.certPath,
    },
    async route(pattern, handler) {
      // Newest first so user-supplied test routes override worker defaults.
      routes.unshift({ pattern, handler });
    },
    unrouteAll() {
      routes.length = 0;
    },
    async close() {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => internal.close(() => resolve()));
      await ca.cleanup();
    },
  };
}

interface TLSSocketWithHost extends TLSSocket {
  _kbAuthority?: string;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routes: Registration[],
  scheme: "http" | "https",
  passthroughDispatcher: Agent,
): Promise<void> {
  const url = absoluteUrl(req, scheme);
  if (!url) {
    res.writeHead(400);
    res.end("bad request line");
    return;
  }

  // Buffer the request body so the handler gets a fetch-API Request.
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);

  for (const { pattern, handler } of routes) {
    if (!matchPattern(pattern, url)) continue;
    const route = new Route(req, res, url, body, passthroughDispatcher);
    try {
      await handler(route);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`route handler threw: ${(err as Error).message}`);
      } else {
        res.socket?.destroy();
      }
      return;
    }
    if (!route.isSettled()) {
      // Handler returned without settling — fall through to passthrough.
      // (Matches Playwright-ish "did nothing → continue".)
      await passthrough(req, res, url, body, passthroughDispatcher);
    }
    return;
  }
  await passthrough(req, res, url, body, passthroughDispatcher);
}

function absoluteUrl(req: IncomingMessage, scheme: "http" | "https"): string | null {
  const url = req.url ?? "";
  // Absolute form (plain HTTP proxy request): http://host/path
  if (/^https?:\/\//.test(url)) return url;
  // Origin form on an MITM-ed TLS socket: /path. Use stashed authority.
  const sock = req.socket as TLSSocketWithHost | Socket;
  const authority =
    ("_kbAuthority" in sock && sock._kbAuthority) ||
    (typeof req.headers.host === "string" ? req.headers.host : undefined);
  if (!authority) return null;
  // Strip the default port — `https://host:443/...` is the same URL as
  // `https://host/...` but only the latter form matches user patterns.
  const defaultPort = scheme === "https" ? "443" : "80";
  const norm =
    authority.endsWith(`:${defaultPort}`) &&
    authority.indexOf(":") === authority.length - defaultPort.length - 1
      ? authority.slice(0, -defaultPort.length - 1)
      : authority;
  return `${scheme}://${norm}${url}`;
}

async function passthrough(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  body: Buffer,
  passthroughDispatcher: Agent,
): Promise<void> {
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i];
    const v = req.rawHeaders[i + 1];
    const kl = k.toLowerCase();
    if (HOP_BY_HOP.has(kl) || kl === "host" || kl === "content-length") continue;
    headers.append(k, v);
  }

  const init: RequestInit & { dispatcher: unknown } = {
    method,
    headers,
    redirect: "manual",
    dispatcher: passthroughDispatcher,
  };
  if (methodHasBody(method) && body.length > 0) {
    const u8 = new Uint8Array(body.byteLength);
    u8.set(body);
    init.body = u8 as unknown as BodyInit;
  }

  let upstream;
  try {
    upstream = await fetch(url, init);
  } catch (err) {
    if (process.env.PROXY_LOG_UNMATCHED === "1") {
      console.warn(`[proxy] passthrough error ${method} ${url}: ${(err as Error).message}`);
    }
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`proxy passthrough failed: ${(err as Error).message}`);
    } else {
      res.socket?.destroy();
    }
    return;
  }

  if (process.env.PROXY_LOG_UNMATCHED === "1") {
    console.log(`[proxy] passthrough ${method} ${url} → ${upstream.status}`);
  }

  const outHeaders: Record<string, string | string[]> = {};
  upstream.headers.forEach((value, key) => {
    const kl = key.toLowerCase();
    if (HOP_BY_HOP.has(kl)) return;
    outHeaders[key] = value;
  });
  res.writeHead(upstream.status, upstream.statusText, outHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(upstream.body as never), res);
  } catch {
    res.socket?.destroy();
  }
}

function methodHasBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "DELETE" && m !== "OPTIONS";
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);
