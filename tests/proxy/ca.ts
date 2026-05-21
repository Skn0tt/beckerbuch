// Generate a self-signed CA cert + key once per worker. The cert PEM
// is written to a temp file so we can pass its path to
// NODE_EXTRA_CA_CERTS for the vite child — that's how undici (Node's
// built-in fetch) learns to trust certs minted by us in the cert-cache.

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";

export interface CA {
  /** node-forge cert object — used to sign leaf certs. */
  cert: forge.pki.Certificate;
  /** node-forge keypair — `privateKey` signs leaves. */
  keys: forge.pki.rsa.KeyPair;
  /** PEM-encoded CA cert. */
  certPem: string;
  /** PEM-encoded CA private key. */
  keyPem: string;
  /** Path to a tempfile containing certPem (for NODE_EXTRA_CA_CERTS). */
  certPath: string;
  /** Remove the tempdir holding certPath. */
  cleanup: () => Promise<void>;
}

export async function createCA(): Promise<CA> {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs: forge.pki.CertificateField[] = [
    { name: "commonName", value: "cookbook test proxy CA" },
    { name: "organizationName", value: "cookbook tests" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    {
      name: "keyUsage",
      keyCertSign: true,
      digitalSignature: true,
      cRLSign: true,
    },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  const dir = await mkdtemp(join(tmpdir(), "cookbook-proxy-ca-"));
  const certPath = join(dir, "ca.pem");
  await writeFile(certPath, certPem);

  return {
    cert,
    keys,
    certPem,
    keyPem,
    certPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function randomSerial(): string {
  // Positive integer encoded as hex; leading zero pad to avoid two's
  // complement negative-serial weirdness when DER-encoded.
  const bytes = forge.random.getBytesSync(16);
  return "00" + forge.util.bytesToHex(bytes);
}
