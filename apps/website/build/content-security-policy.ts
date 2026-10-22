import type { Plugin } from "vite-plus";

// GitHub Pages cannot send headers, so the policy ships as a meta tag. Any script
// running on this origin can read the user's recordings through the extension.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Adds the policy to built pages only; the dev server needs inline HMR code. */
export function contentSecurityPolicy(): Plugin {
  return {
    name: "recnrun-content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
        injectTo: "head-prepend",
      },
    ],
  };
}
