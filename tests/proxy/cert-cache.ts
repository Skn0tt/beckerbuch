// Mint per-host leaf certs signed by the worker CA. Used by the
// proxy's SNICallback: when a TLS client says "I want to talk to
// share.kptncook.com", we hand it a freshly minted cert for that
// hostname.

import tls from "node:tls";
import forge from "node-forge";
import type { CA } from "./ca";

export class CertCache {
  // hostname -> SecureContext. Map keeps insertion order so we can
  // evict oldest on cap. ~50ms/host with RSA-2048; suites only touch
  // a handful of hostnames so this is effectively warm after test 1.
  private readonly cache = new Map<string, tls.SecureContext>();
  private readonly cap: number;

  constructor(
    private readonly ca: CA,
    cap = 100,
  ) {
    this.cap = cap;
  }

  get(hostname: string): tls.SecureContext {
    const cached = this.cache.get(hostname);
    if (cached) return cached;

    const ctx = tls.createSecureContext(this.mint(hostname));
    if (this.cache.size >= this.cap) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(hostname, ctx);
    return ctx;
  }

  private mint(hostname: string): { cert: string; key: string } {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    cert.setSubject([{ name: "commonName", value: hostname }]);
    cert.setIssuer(this.ca.cert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      {
        name: "keyUsage",
        digitalSignature: true,
        keyEncipherment: true,
      },
      {
        name: "extKeyUsage",
        serverAuth: true,
        clientAuth: true,
      },
      {
        name: "subjectAltName",
        altNames: subjectAltNames(hostname),
      },
    ]);
    cert.sign(this.ca.keys.privateKey, forge.md.sha256.create());

    return {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
    };
  }
}

// node-forge doesn't export the GeneralName type; the shape below
// matches what forge.pki accepts at runtime.
type GeneralName = { type: number; value?: string; ip?: string };

function subjectAltNames(hostname: string): GeneralName[] {
  // Type 7 = IP, type 2 = DNS. Naïve check is fine here — hostnames
  // arriving via SNI/CONNECT are either a DNS name or a numeric IP.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return [{ type: 7, ip: hostname }];
  }
  return [{ type: 2, value: hostname }];
}

function randomSerial(): string {
  const bytes = forge.random.getBytesSync(16);
  return "00" + forge.util.bytesToHex(bytes);
}
