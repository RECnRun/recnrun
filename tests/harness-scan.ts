import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseAst } from "vite-plus";

/**
 * Finds what the POC harness asks of Chrome: CDP commands at `send` call sites, launch flags in
 * string literals, and Playwright calls that would send capability-providing commands. Names used
 * as data (an argument to anything but `send`, a comment) are not call sites.
 */
export interface Site {
  file: string;
  line: number;
  kind: "cdp" | "dynamic-cdp" | "flag" | "playwright" | "launch";
  /** The command, the flag up to `=`, the Playwright method, or for `launch` whether it names an `executable`. */
  name: string;
  /** The innermost named function around the site. */
  within?: string;
}

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const CDP_METHOD = /^[A-Z][A-Za-z]*\.[a-z][A-Za-z]*$/;
// Playwright methods that send Fetch.*, Emulation.*, Network.setCookie(s), or page-target Runtime commands.
const PLAYWRIGHT_FORBIDDEN = new Set([
  "route",
  "routeFromHAR",
  "routeWebSocket",
  "addInitScript",
  "setExtraHTTPHeaders",
  "setOffline",
  "setGeolocation",
  "grantPermissions",
  "addCookies",
  "clearCookies",
  "emulateMedia",
  "setViewportSize",
  "exposeFunction",
  "exposeBinding",
  "evaluate",
  "evaluateHandle",
  "evaluateAll",
  "$eval",
  "$$eval",
]);

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function children(node: AstNode): AstNode[] {
  return Object.values(node).flatMap((value) => {
    if (Array.isArray(value)) return value.filter(isNode);
    return isNode(value) ? [value] : [];
  });
}

function stringValue(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  const quasis = node.quasis as { value: { cooked: string } }[] | undefined;
  const expressions = node.expressions as unknown[] | undefined;
  if (node.type === "TemplateLiteral" && quasis && expressions?.length === 0) {
    return quasis[0]?.value.cooked;
  }
  return undefined;
}

function calleeName(node: AstNode): string | undefined {
  const callee = node.callee;
  if (!isNode(callee)) return undefined;
  if (callee.type === "Identifier") return callee.name as string;
  if (callee.type !== "MemberExpression") return undefined;
  const property = callee.property as AstNode;
  return callee.computed ? stringValue(property) : (property.name as string);
}

function hasExecutable(argument: unknown): boolean {
  if (!isNode(argument) || argument.type !== "ObjectExpression") return false;
  const properties = argument.properties as AstNode[];
  return properties.some((property) => isNode(property.key) && property.key.name === "executable");
}

type Found = Omit<Site, "file" | "line" | "within">;

function callSite(node: AstNode): Found | undefined {
  const name = calleeName(node);
  const [first] = node.arguments as unknown[];
  if (name === "launchChrome") return { kind: "launch", name: String(hasExecutable(first)) };
  if (name && PLAYWRIGHT_FORBIDDEN.has(name) && isNode(node.callee)) {
    if (node.callee.type === "MemberExpression") return { kind: "playwright", name };
  }
  if (name !== "send") return undefined;
  const method = stringValue(first);
  if (method === undefined) return { kind: "dynamic-cdp", name: "<computed>" };
  return CDP_METHOD.test(method) ? { kind: "cdp", name: method } : undefined;
}

function flagSite(node: AstNode): Found | undefined {
  let text = stringValue(node);
  if (text === undefined && node.type === "TemplateLiteral") {
    text = (node.quasis as { value: { cooked: string } }[])[0]?.value.cooked;
  }
  if (!text?.startsWith("--") || !/^--[a-z]/.test(text)) return undefined;
  return { kind: "flag", name: text.split("=")[0] ?? text };
}

function functionName(node: AstNode): string | undefined {
  if (node.type === "FunctionDeclaration" && isNode(node.id)) return node.id.name as string;
  return undefined;
}

/** Every site in one source file; `file` is reported as given. */
export function scanSource(file: string, code: string): Site[] {
  const lineOf = (offset: number) => code.slice(0, offset).split("\n").length;
  const sites: Site[] = [];
  const visit = (node: AstNode, within: string | undefined): void => {
    const scope = functionName(node) ?? within;
    const found = node.type === "CallExpression" ? callSite(node) : flagSite(node);
    if (found)
      sites.push({ file, line: lineOf(node.start), ...found, ...(scope ? { within: scope } : {}) });
    for (const child of children(node)) visit(child, scope);
  };
  visit(parseAst(code, { lang: "ts" }) as unknown as AstNode, undefined);
  return sites;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** Scans the POC harness: `tests/browser` and `tests/experiments`, relative paths from `root`. */
export async function scanHarness(root: string): Promise<Site[]> {
  const directories = ["tests/browser", "tests/experiments"].map((directory) =>
    join(root, directory),
  );
  const files = (await Promise.all(directories.map(sourceFiles))).flat();
  const scans = files.map(async (file) =>
    scanSource(relative(root, file), await readFile(file, "utf8")),
  );
  return (await Promise.all(scans)).flat();
}
