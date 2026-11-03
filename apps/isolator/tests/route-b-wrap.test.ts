import { BOOTSTRAP_SOURCE, withMarker } from "@recnrun/worker-bootstrap";
import { describe, expect, test } from "vite-plus/test";
import { renderModuleResource } from "@/background/route-b/module-resource";
import {
  byteLength,
  decodeBase64,
  encodeBase64,
  fulfilledHeaders,
  hasStaticImport,
  wrapScript,
} from "@/background/route-b/wrap";

const MODULE_URL = "chrome-extension://isolator/route-b/bootstrap.js";

describe("Route B wrapper", () => {
  test("prepends the bootstrap to a classic script and stays byte-stable", () => {
    const body = "importScripts('/sw-main.js');\n";
    const wrapped = wrapScript("m1", body, MODULE_URL);
    expect(wrapped).toEqual({ body: `${withMarker("m1")};\n${body}`, wrapper: "prepend" });
    expect(wrapScript("m1", body, MODULE_URL)).toEqual(wrapped);
    expect(wrapScript("m2", body, MODULE_URL).body).not.toBe(wrapped.body);
  });

  test("imports the bootstrap module first, with the marker in its query, when imports are hoisted", () => {
    const body = 'import "./sw-main.js";\nimport("./sw-lazy.js");\n';
    expect(wrapScript("m1", body, MODULE_URL)).toEqual({
      body: `import "${MODULE_URL}?marker=m1";\n${body}`,
      wrapper: "module-import",
    });
  });

  test("tells static imports from dynamic imports, importScripts, and import.meta", () => {
    const hoisted = [
      'import "./a.js";',
      "import a from './a.js';",
      'import { a } from "./a.js";',
      "import * as a from './a.js';",
      '// first\n  import"./a.js";',
      "const x = 1;\nimport {\n  a,\n} from './a.js';",
    ];
    const notHoisted = [
      'import("./a.js");',
      'importScripts("/a.js");',
      "const url = import.meta.url;",
      'const text = "no import here";',
      "await import ('./a.js');",
    ];
    expect(hoisted.map(hasStaticImport)).toEqual(hoisted.map(() => true));
    expect(notHoisted.map(hasStaticImport)).toEqual(notHoisted.map(() => false));
  });

  test("encodes and decodes UTF-8 bodies as base64 and counts their bytes", () => {
    const text = "const label = 'café ☕';\n";
    expect(decodeBase64(encodeBase64(text))).toBe(text);
    expect(encodeBase64("abc")).toBe("YWJj");
    expect(byteLength(text)).toBe(new TextEncoder().encode(text).length);
  });

  test("drops the length and encoding of the original body and keeps every other header", () => {
    const headers = [
      { name: "content-type", value: "text/javascript" },
      { name: "Content-Length", value: "10" },
      { name: "Content-Encoding", value: "gzip" },
      { name: "Service-Worker-Allowed", value: "/" },
      { name: "Content-Security-Policy", value: "default-src 'self'" },
      { name: "Cache-Control", value: "no-cache" },
    ];
    expect(fulfilledHeaders(headers).map((header) => header.name)).toEqual([
      "content-type",
      "Service-Worker-Allowed",
      "Content-Security-Policy",
      "Cache-Control",
    ]);
  });

  test("renders the module resource that reads its marker from its own URL", () => {
    expect(renderModuleResource(BOOTSTRAP_SOURCE)).toBe(
      [
        'const marker = new URL(import.meta.url).searchParams.get("marker");',
        `${BOOTSTRAP_SOURCE}({ marker });`,
        "",
      ].join("\n"),
    );
  });
});
