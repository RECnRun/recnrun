import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { isUiPath, serveUi, UI_CSP } from "@/static";

interface Sent {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function response() {
  const sent: Sent = { status: 0, headers: {}, body: "" };
  const fake = {
    writeHead(status: number, headers: Record<string, string>) {
      sent.status = status;
      sent.headers = headers;
    },
    end(body: string | Buffer) {
      sent.body = String(body);
    },
  };
  return { sent, response: fake as unknown as ServerResponse };
}

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "recnrun-ui-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<html><head><title>UI</title></head></html>");
  await writeFile(join(root, "assets", "app-1a2b.js"), "export {};");
});

afterAll(() => rm(root, { recursive: true, force: true }));

test("only the page and flat asset names are UI paths", () => {
  expect(["/", "/index.html", "/assets/app-1a2b.js"].every(isUiPath)).toBe(true);
  const refused = ["/api", "/assets/", "/assets/../index.html", "/assets/a/b.js", "/x.js"];
  expect(refused.some(isUiPath)).toBe(false);
});

test("index.html carries the token meta, the CSP, and is never cached", async () => {
  const { sent, response: res } = response();
  await serveUi(root, "/", "secret-token", res);
  expect(sent.status).toBe(200);
  expect(sent.body).toBe(
    '<html><head><title>UI</title><meta name="recnrun-token" content="secret-token"></head></html>',
  );
  expect(sent.headers).toMatchObject({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": UI_CSP,
    "cache-control": "no-store",
    "x-frame-options": "DENY",
  });
  expect(UI_CSP).toContain("connect-src 'self' ws://127.0.0.1:* ws://localhost:*");
});

test("an asset is served with its type and without the token", async () => {
  const { sent, response: res } = response();
  await serveUi(root, "/assets/app-1a2b.js", "secret-token", res);
  expect(sent).toMatchObject({ status: 200, body: "export {};" });
  expect(sent.headers["content-type"]).toBe("text/javascript; charset=utf-8");
});

test("a missing asset is 404 and a missing build is 503 with the remedy", async () => {
  const missing = response();
  await serveUi(root, "/assets/gone.js", "t", missing.response);
  expect(missing.sent.status).toBe(404);
  const unbuilt = response();
  await serveUi(join(root, "nowhere"), "/", "t", unbuilt.response);
  expect(unbuilt.sent).toMatchObject({ status: 503 });
  expect(unbuilt.sent.body).toContain("vp run -r build");
});
