import { BOOTSTRAP_FILE, slotFile, strategyFile } from "@/content/route-c/names";
import type { WorkerStrategy } from "@/content/route-c/names";

export type WorkerKind = "Worker" | "SharedWorker";

type WorkerConstructor = abstract new (...args: never[]) => object;

/** What a wrapped constructor needs, captured when the page bootstrap starts. */
export interface WorkerContext {
  strategy: WorkerStrategy;
  /** The slot marker the page carries, which its workers inherit. */
  marker: string;
  /** `chrome-extension://<id>/`, where the worker imports the slot and the bootstrap from. */
  base: string | undefined;
  /** Why every worker is refused, when the page bootstrap itself failed. */
  refusal?: string;
  /** What the native constructor resolves a relative script URL against. */
  baseUrl(): string;
  createObjectURL(blob: Blob): string;
}

// The HTML standard makes a worker's location its constructor URL, so a blob: or data: wrapper changes it.
const NO_WRAPPER = "no wrapper keeps the worker's own self.location, baseURI, and relative imports";
const NO_BASE = "the extension base URL is unknown";

/** The wrapper script: the bootstrap files first, then the original script by absolute URL. */
export function wrapperSource(
  kind: "classic" | "module",
  imports: string[],
  original: string,
): string {
  const quoted = imports.map((url) => JSON.stringify(url));
  if (kind === "module") {
    return [...quoted, JSON.stringify(original)].map((url) => `import ${url};\n`).join("");
  }
  return `importScripts(${quoted.join(", ")});\nimportScripts(${JSON.stringify(original)});\n`;
}

function refuse(kind: WorkerKind, url: unknown, reason: string): DOMException {
  const message = `RECnRun Route C refused new ${kind}(${String(url)}): ${reason}`;
  return new DOMException(message, "SecurityError");
}

function typeOf(options: unknown): "classic" | "module" {
  const type = typeof options === "object" && options ? Reflect.get(options, "type") : undefined;
  return type === "module" ? "module" : "classic";
}

function refusalOf(context: WorkerContext): string | undefined {
  if (context.refusal !== undefined) return context.refusal;
  if (context.strategy === "fail-closed") return NO_WRAPPER;
  return context.base === undefined ? NO_BASE : undefined;
}

/** The URL the native constructor gets instead of `url`, or the refusal it throws. */
function wrappedUrl(kind: WorkerKind, args: unknown[], context: WorkerContext): string {
  const [url, options] = args;
  const reason = refusalOf(context);
  if (reason !== undefined) throw refuse(kind, url, reason);
  const baseUrl = context.baseUrl();
  if (!URL.canParse(String(url), baseUrl)) {
    throw refuse(kind, url, `the script URL does not resolve against ${baseUrl}`);
  }
  const files = [slotFile(context.marker), strategyFile(context.strategy), BOOTSTRAP_FILE];
  const imports = files.flatMap((file) => (file ? [`${context.base ?? ""}${file}`] : []));
  const source = wrapperSource(typeOf(options), imports, new URL(String(url), baseUrl).href);
  if (context.strategy === "data") {
    return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
  }
  return context.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

/** `native` behind a proxy whose `new` starts the wrapper instead, or throws before any worker starts. */
export function wrapConstructor<T extends WorkerConstructor>(
  native: T,
  kind: WorkerKind,
  context: WorkerContext,
): T {
  return new Proxy(native, {
    construct(target, args: unknown[], newTarget) {
      const url = wrappedUrl(kind, args, context);
      return Reflect.construct(target, [url, ...args.slice(1)], newTarget) as object;
    },
  });
}
