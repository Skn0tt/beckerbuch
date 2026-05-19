// Mockttp-backed HTTP(S) proxy for the test rig. dev.mjs starts one
// instance per boot and points the netlify-dev child process at it via
// HTTPS_PROXY + NODE_USE_ENV_PROXY=1 + NODE_EXTRA_CA_CERTS, so the app
// can call real upstream hostnames (mobile.kptncook.com,
// api.openai.com, …) and have the proxy mock the response.
//
// Adding a new external API to mock = drop a new `handlers/<name>.mjs`
// that exports a `register*(server)` function and call it from
// startMockProxy below. No app-code changes required.

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocal, generateCACertificate } from "mockttp";
import { registerKptncookHandlers } from "./handlers/kptncook.mjs";
import { registerOpenAiHandlers } from "./handlers/openai.mjs";

export async function startMockProxy() {
  const ca = await generateCACertificate();
  const dir = await mkdtemp(join(tmpdir(), "cookbook-proxy-ca-"));
  const caCertPath = join(dir, "ca.pem");
  await writeFile(caCertPath, ca.cert);

  const server = getLocal({
    https: { cert: ca.cert, key: ca.key },
    // Quiet by default; flip to true when debugging a proxy miss.
    debug: false,
  });
  await server.start();

  await registerKptncookHandlers(server);
  await registerOpenAiHandlers(server);

  // Default policy: requests we didn't explicitly mock are passed
  // through to the real network. This keeps the Netlify CLI's own
  // backend chatter (api.netlify.com, CDN downloads for edge-function
  // runtimes, etc.) working transparently — that traffic isn't from
  // app code and we don't want to mock it.
  //
  // Trade-off: if app code grows a new external integration and we
  // forget to add a handler, the test will silently hit the real
  // upstream instead of failing fast. The mitigation is to keep the
  // list of external upstreams the app talks to short and reviewed.
  await server.forUnmatchedRequest().thenPassThrough({
    beforeRequest: (req) => {
      if (process.env.PROXY_LOG_UNMATCHED === "1") {
        console.log(`[proxy] passthrough ${req.method} ${req.url}`);
      }
    },
  });

  return {
    /** mockttp HTTPS proxy URL, e.g. `https://localhost:54321`. */
    url: server.url,
    /** Env block ready to merge into a child process env. */
    proxyEnv: {
      ...server.proxyEnv,
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: caCertPath,
    },
    caCertPath,
    async stop() {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
