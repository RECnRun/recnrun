import { readdir } from "node:fs/promises";
import { describe, expect, test } from "vite-plus/test";
import { createFixtureServer, portsFromEnvironment } from "@/index";
import { ROUTES } from "@/routes";
import { rawRequest, useFixture } from "./harness.ts";

const fixture = useFixture();
const get = (path: string) => fetch(`${fixture.urls.first}${path}`);

describe("pages", () => {
  test("lists every route on the index page", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    for (const { name, title } of ROUTES) {
      expect(html).toContain(`<a href="/routes/${name}" data-testid="route-${name}">${title}</a>`);
    }
    expect(html).toContain('<script type="module" src="/index.js"></script>');
  });

  test.each(ROUTES.map(({ name }) => name))("serves the %s page and its script", async (name) => {
    const page = await get(`/routes/${name}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain(`<script type="module" src="/routes/${name}.js"></script>`);
    const script = await get(`/routes/${name}.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  test("has exactly one listed route per page file", async () => {
    const files = await readdir(new URL("../public/routes/", import.meta.url));
    const pages = files.filter((file) => file.endsWith(".html")).map((file) => file.slice(0, -5));
    expect(pages.toSorted()).toEqual(ROUTES.map(({ name }) => name).toSorted());
  });

  test("serves the shared script, the stylesheet, and the service worker", async () => {
    for (const [path, type] of [
      ["/fixture.js", "text/javascript; charset=utf-8"],
      ["/fixture.css", "text/css; charset=utf-8"],
      ["/sw.js", "text/javascript; charset=utf-8"],
    ]) {
      const response = await get(path ?? "");
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe(type);
    }
  });

  test("answers HEAD with the headers and no body", async () => {
    const response = await fetch(`${fixture.urls.first}/fixture.js`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toBe("");
  });

  test("answers 404 for an unknown route or file", async () => {
    expect((await get("/routes/missing")).status).toBe(404);
    expect((await get("/missing.js")).status).toBe(404);
    expect((await get("/routes")).status).toBe(404);
  });

  test("answers 405 to a write on a page", async () => {
    const response = await fetch(`${fixture.urls.first}/routes/form`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("security", () => {
  test("sets nosniff on pages, files, API answers, and errors", async () => {
    for (const path of ["/", "/fixture.js", "/api/json", "/missing"]) {
      expect((await get(path)).headers.get("x-content-type-options"), path).toBe("nosniff");
    }
  });

  test.each([
    "/../package.json",
    "/..%2fpackage.json",
    "/%2e%2e/%2e%2e/package.json",
    "/routes/..%2f..%2fpackage.json",
    "/%2e%2e%5cpackage.json",
    "/fixture.js%00.html",
  ])("never serves a file outside public/ for %s", async (path) => {
    const response = await rawRequest(fixture.urls.first, path);
    expect([400, 404]).toContain(response.status);
    expect(response.body).not.toContain("@recnrun/fixture");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  test("rejects a malformed percent-encoding", async () => {
    expect((await rawRequest(fixture.urls.first, "/%E0%A4%A")).status).toBe(400);
  });

  test("listens on loopback only, the second origin under another host name", () => {
    expect(fixture.urls.first).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(fixture.urls.second).toMatch(/^http:\/\/localhost:\d+$/);
    expect(fixture.urls.second).not.toBe(fixture.urls.first.replace("127.0.0.1", "localhost"));
  });

  test("serves the same pages on the second origin", async () => {
    const port = new URL(fixture.urls.second).port;
    expect((await fetch(`http://127.0.0.1:${port}/routes/iframe-child`)).status).toBe(200);
  });
});

describe("lifecycle", () => {
  test("stops listening on both ports", async () => {
    const server = createFixtureServer({ port: 0, secondPort: 0 });
    const urls = await server.start();
    expect((await fetch(`${urls.first}/`)).status).toBe(200);
    await server.stop();
    await expect(fetch(`${urls.first}/`)).rejects.toThrow();
    await expect(fetch(urls.second.replace("localhost", "127.0.0.1"))).rejects.toThrow();
  });

  test("reads its ports from the environment with 4600 and 4601 by default", () => {
    expect(portsFromEnvironment({})).toEqual({ port: 4600, secondPort: 4601 });
    expect(
      portsFromEnvironment({ RECNRUN_FIXTURE_PORT: "5600", RECNRUN_FIXTURE_SECOND_PORT: "5601" }),
    ).toEqual({ port: 5600, secondPort: 5601 });
  });
});
