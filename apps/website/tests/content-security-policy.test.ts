import { expect, test } from "vite-plus/test";
import { CONTENT_SECURITY_POLICY, contentSecurityPolicy } from "@build/content-security-policy";

test("the policy forbids inline and third-party scripts", () => {
  expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
  expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
});

test("the plugin injects the policy only into built pages", () => {
  const plugin = contentSecurityPolicy();
  expect(plugin.apply).toBe("build");
  const transform = plugin.transformIndexHtml;
  if (typeof transform !== "function") throw new Error("transformIndexHtml must be a function.");
  expect(transform.call({} as never, "", {} as never)).toEqual([
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
      injectTo: "head-prepend",
    },
  ]);
});
