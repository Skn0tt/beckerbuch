// Bare-minimum mockttp boot: CA gen, HTTPS server, env block, close.
// No routing, no event bridging, no Playwright shapes — that's what
// the sibling `playwright-mocks` library is for. Here `mocks` is the
// raw `Mockttp` instance and tests use mockttp's API directly.

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateCACertificate,
  getLocal,
  type Mockttp,
} from "mockttp";

export interface MockttpHandle {
  /** The mockttp server itself — use its API directly to declare rules. */
  server: Mockttp;
  /** Forward-proxy URL (http://127.0.0.1:NNNNN). */
  url: string;
  /** Path to the auto-generated CA PEM, suitable for NODE_EXTRA_CA_CERTS. */
  caCertPath: string;
  /** Same content as a string, for in-memory consumers. */
  caCertPem: string;
  /** Env block to merge into child processes that should route through us. */
  env: NodeJS.ProcessEnv;
  /** Stop mockttp and clean up the temp CA dir. */
  close(): Promise<void>;
}

export interface CreateProxyOptions {
  /**
   * Extra CA PEM(s) the upstream-passthrough should trust. Only useful
   * when the upstream is itself a test fixture with a synthetic cert.
   */
  trustedUpstreamCa?: string | string[];
}

export async function createProxy(
  options: CreateProxyOptions = {},
): Promise<MockttpHandle> {
  const ca = await generateCACertificate();
  const dir = await mkdtemp(join(tmpdir(), "mockttp-fixture-ca-"));
  const caCertPath = join(dir, "ca.pem");
  await writeFile(caCertPath, ca.cert);

  const extraCAs = options.trustedUpstreamCa
    ? (Array.isArray(options.trustedUpstreamCa)
        ? options.trustedUpstreamCa
        : [options.trustedUpstreamCa]
      ).map((cert) => ({ cert }))
    : undefined;

  const server = getLocal({ https: { cert: ca.cert, key: ca.key } });
  await server.start();

  // Without this default, any URL the test didn't explicitly mock
  // returns 503 — which makes "mock just one thing, let the rest
  // through" tests impossible. Trade-off: a forgotten mock silently
  // hits the real internet. Keep the upstream allowlist small.
  await server.forUnmatchedRequest().thenPassThrough({
    additionalTrustedCAs: extraCAs,
  });

  return {
    server,
    url: server.url,
    caCertPath,
    caCertPem: ca.cert,
    env: {
      HTTPS_PROXY: server.url,
      HTTP_PROXY: server.url,
      NO_PROXY: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: caCertPath,
    },
    async close() {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
