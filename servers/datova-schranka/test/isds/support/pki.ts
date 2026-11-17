import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface KeyPair {
  readonly key: string;
  readonly cert: string;
}

/** A throwaway PKI generated with the `openssl` CLI; nothing is committed. */
export interface TestPki {
  /** The CA that signs `server` and `client`; the transport trusts it via `additionalTrustedCa`. */
  readonly caCert: string;
  /** Server certificate for 127.0.0.1 and localhost, signed by the test CA. */
  readonly server: KeyPair;
  /** A server certificate for 127.0.0.1 from a different CA the transport doesn't trust. */
  readonly rogueServer: KeyPair;
  /** The client certificate and key with the test CA, as PKCS#12 protected by `clientPassphrase`. */
  readonly clientPkcs12: Uint8Array;
  readonly clientPassphrase: string;
  readonly clientCommonName: string;
}

const opensslConfig = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = unused
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[server]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1,DNS:localhost
authorityKeyIdentifier = keyid
[client]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = clientAuth
authorityKeyIdentifier = keyid
`;

/** Generates the PKI into a temporary directory, reads it into memory and deletes the directory. */
export const createTestPki = (): TestPki => {
  const dir = mkdtempSync(join(tmpdir(), "isds-transport-pki-"));
  try {
    return generate(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const generate = (dir: string): TestPki => {
  const openssl = (...args: ReadonlyArray<string>): void => {
    execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  };
  const read = (file: string): string => readFileSync(join(dir, file), "utf8");
  writeFileSync(join(dir, "openssl.cnf"), opensslConfig);
  const newKey = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];

  const makeCa = (name: string): void =>
    openssl("req", "-x509", ...newKey, "-config", "openssl.cnf", "-extensions", "ca", "-days", "2", "-subj", `/CN=${name}`, "-keyout", `${name}.key`, "-out", `${name}.crt`);
  const makeLeaf = (name: string, ca: string, profile: "server" | "client", commonName: string): void => {
    openssl("req", "-new", ...newKey, "-config", "openssl.cnf", "-subj", `/CN=${commonName}`, "-keyout", `${name}.key`, "-out", `${name}.csr`);
    openssl("x509", "-req", "-in", `${name}.csr`, "-CA", `${ca}.crt`, "-CAkey", `${ca}.key`, "-CAcreateserial", "-days", "2", "-extfile", "openssl.cnf", "-extensions", profile, "-out", `${name}.crt`);
  };

  const clientCommonName = "isds-test-box";
  const clientPassphrase = "p12-passphrase-4c1e9a";
  makeCa("test-ca");
  makeCa("rogue-ca");
  makeLeaf("server", "test-ca", "server", "127.0.0.1");
  makeLeaf("rogue-server", "rogue-ca", "server", "127.0.0.1");
  makeLeaf("client", "test-ca", "client", clientCommonName);
  openssl("pkcs12", "-export", "-inkey", "client.key", "-in", "client.crt", "-certfile", "test-ca.crt", "-passout", `pass:${clientPassphrase}`, "-out", "client.p12");

  return {
    caCert: read("test-ca.crt"),
    server: { key: read("server.key"), cert: read("server.crt") },
    rogueServer: { key: read("rogue-server.key"), cert: read("rogue-server.crt") },
    clientPkcs12: new Uint8Array(readFileSync(join(dir, "client.p12"))),
    clientPassphrase,
    clientCommonName,
  };
};
