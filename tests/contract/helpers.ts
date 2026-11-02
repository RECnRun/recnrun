import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vite-plus/test";
import { startService, type RunningService } from "../../apps/service/src/index.ts";
import type { DiscoveryResult } from "../../packages/protocol/src/index.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** What discovery answers in these tests; no Chrome runs here. */
export const NO_CHROME: DiscoveryResult = {
  ok: false,
  code: "missing-file",
  remedy: "Enable remote debugging at chrome://inspect/#remote-debugging and keep Chrome open.",
  userDataDir: "/nowhere",
};

export const tempHome = () => mkdtemp(join(tmpdir(), "recnrun-contract-"));

/** Starts a service that must be the first one for `home`. */
export async function startFresh(home: string): Promise<RunningService> {
  const started = await startService({ home, discover: async () => NO_CHROME });
  if (started.reused) throw new Error(`A service already runs for ${home}.`);
  return started.service;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: unknown;
}

/** One HTTP request with exactly the headers given (fetch would set `Host` itself). */
export function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/api",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            json: JSON.parse(text),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

/** Sends a command envelope with the service's bearer token. */
export const command = (
  service: RunningService,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  send(service.port, {
    headers: { authorization: `Bearer ${service.token}`, ...headers },
    body: JSON.stringify(body),
  });

/** An upgrade request with chosen headers; resolves with the HTTP status it got back. */
export function upgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: "/ws",
      headers: {
        host: `127.0.0.1:${port}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
        ...headers,
      },
    });
    outgoing.on("response", (response) => resolve(response.statusCode ?? 0));
    outgoing.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/** Runs a Node script with `HOME=home` and yields its stdout lines; it is killed if still running when the test ends. */
export function runNode(script: string, args: string[], home: string) {
  const child: ChildProcess = spawn(process.execPath, [join(ROOT, script), ...args], {
    // Chrome discovery resolves its profile from these, so it never reaches the user's real Chrome.
    env: {
      ...process.env,
      HOME: home,
      CHROME_CONFIG_HOME: join(home, ".config"),
      LOCALAPPDATA: join(home, "AppData"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout ?? process.stdin })[Symbol.asyncIterator]();
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  // A failed test must not leave a service running that holds vitest open.
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const nextLine = async () => {
    const next = await lines.next();
    if (next.done === true) throw new Error(`${script} ended without output.`);
    return next.value;
  };
  return { child, exited, nextLine };
}
