import { withMarker } from "@recnrun/worker-bootstrap";
import type { WrapperKind } from "@/background/route-b/types";

export interface Wrapped {
  body: string;
  wrapper: WrapperKind;
}

export interface Header {
  name: string;
  value: string;
}

// A line that starts a static import: a specifier, a brace, a namespace, or a default binding.
const STATIC_IMPORT = /^\s*import(\s*["'{*]|\s+[\w$]+\s*(,|from\b))/m;
// The fulfilled body is decoded text, so its original length and encoding no longer describe it.
const DROPPED_HEADERS = new Set(["content-length", "content-encoding"]);
// String.fromCharCode takes its arguments on the stack; chunks keep large scripts under its limit.
const CHUNK = 0x8000;

/** Whether the script has a static import, which a module evaluates before its own first statement. */
export function hasStaticImport(body: string): boolean {
  return STATIC_IMPORT.test(body);
}

/**
 * The script with the bootstrap of `marker` first: prepended to a script whose first statement runs
 * first, or as a static import of `moduleUrl` when hoisted imports would run before it.
 */
export function wrapScript(marker: string, body: string, moduleUrl: string): Wrapped {
  if (hasStaticImport(body)) {
    const specifier = JSON.stringify(`${moduleUrl}?marker=${marker}`);
    return { body: `import ${specifier};\n${body}`, wrapper: "module-import" };
  }
  return { body: `${withMarker(marker)};\n${body}`, wrapper: "prepend" };
}

export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

export function decodeBase64(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The original response headers for a wrapped body. */
export function fulfilledHeaders(headers: Header[]): Header[] {
  return headers.filter((header) => !DROPPED_HEADERS.has(header.name.toLowerCase()));
}
