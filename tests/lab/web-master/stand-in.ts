import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/*
 * The HTTPS stand-in for recnrun.com: `https://recnrun.test:<port>` on the loopback, its chain
 * issued by a throwaway CA that Chrome trusts through the managed `CACertificates` policy, since
 * the image has no NSS `certutil`. The runner maps recnrun.test to 127.0.0.1 (`--add-host`).
 */

export const HOST = "recnrun.test";
const POLICY_DIRECTORY = "/etc/opt/chrome/policies/managed";
const POLICY_FILE = join(POLICY_DIRECTORY, "recnrun-lab-ca.json");
const SITE = fileURLToPath(new URL("site/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};
const run = promisify(execFile);

export interface StandIn {
  origin: string;
  port: number;
  close(): Promise<void>;
}

function requireContainer(): void {
  if (process.env.RECNRUN_TEST_CONTAINER !== "1" || !existsSync("/.dockerenv")) {
    throw new Error(
      "The web-master lab writes a Chrome policy; run it with `vp run lab:web-master`.",
    );
  }
}

async function issueChain(
  directory: string,
): Promise<{ caDer: Buffer; key: Buffer; cert: Buffer }> {
  const file = (name: string) => join(directory, name);
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  await run("openssl", [
    "req",
    "-x509",
    ...ec,
    "-keyout",
    file("ca.key"),
    "-out",
    file("ca.pem"),
    "-days",
    "2",
    "-subj",
    "/CN=RECnRun lab CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  await run("openssl", [
    "req",
    ...ec,
    "-keyout",
    file("leaf.key"),
    "-out",
    file("leaf.csr"),
    "-subj",
    `/CN=${HOST}`,
  ]);
  await writeFile(
    file("leaf.ext"),
    [
      `subjectAltName=DNS:${HOST}`,
      "extendedKeyUsage=serverAuth",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
    ].join("\n"),
  );
  await run("openssl", [
    "x509",
    "-req",
    "-in",
    file("leaf.csr"),
    "-CA",
    file("ca.pem"),
    "-CAkey",
    file("ca.key"),
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    file("leaf.ext"),
    "-out",
    file("leaf.pem"),
  ]);
  await run("openssl", ["x509", "-in", file("ca.pem"), "-outform", "DER", "-out", file("ca.der")]);
  const caDer = await readFile(file("ca.der"));
  const key = await readFile(file("leaf.key"));
  const cert = await readFile(file("leaf.pem"));
  return { caDer, key, cert };
}

/** Starts the stand-in; the policy must exist before any Chrome of the lab starts. */
export async function startStandIn(): Promise<StandIn> {
  requireContainer();
  const directory = await mkdtemp(join(tmpdir(), "recnrun-lab-ca-"));
  const { caDer, key, cert } = await issueChain(directory);
  await mkdir(POLICY_DIRECTORY, { recursive: true });
  await writeFile(POLICY_FILE, JSON.stringify({ CACertificates: [caDer.toString("base64")] }), {
    flag: "wx",
  });
  const server = createServer({ key, cert }, (request, response) => {
    const name = request.url === "/" ? "index.html" : (request.url ?? "").slice(1);
    const type = TYPES[extname(name)];
    if (!type || name.includes("/")) {
      response.writeHead(404).end();
      return;
    }
    void readFile(join(SITE, name)).then(
      (body) => response.writeHead(200, { "content-type": type }).end(body),
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(POLICY_FILE, { force: true });
    await rm(directory, { recursive: true, force: true });
  };
  return { origin: `https://${HOST}:${port}`, port, close };
}
