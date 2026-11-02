import { request } from "node:http";
import { afterAll, beforeAll } from "vite-plus/test";
import { createFixtureServer, type FixtureServer } from "@/index";

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Starts a fixture on free ports for the enclosing file and stops it afterwards. */
export function useFixture(): FixtureServer {
  const server = createFixtureServer({ port: 0, secondPort: 0 });
  beforeAll(async () => {
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  return server;
}

/** Sends the path byte for byte, which fetch would normalize. */
export function rawRequest(origin: string, path: string, method = "GET"): Promise<RawResponse> {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname, port, path, method }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
      );
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}
