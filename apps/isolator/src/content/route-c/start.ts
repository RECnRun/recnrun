import { installBootstrap } from "@recnrun/isolation-core";
import {
  MARKER_GLOBAL,
  ORIGINAL_GLOBAL,
  ORIGINAL_SLOT,
  STRATEGY_GLOBAL,
  WORKER_STRATEGIES,
} from "@/content/route-c/names";
import type { WorkerStrategy } from "@/content/route-c/names";
import { wrapConstructor } from "@/content/route-c/wrap-workers";
import type { WorkerContext, WorkerKind } from "@/content/route-c/wrap-workers";

// The MAIN world has no chrome.runtime, so the bootstrap learns its own URL from a stack frame.
const EXTENSION_BASE = /chrome-extension:\/\/[a-p]{32}\//;
const KINDS: WorkerKind[] = ["Worker", "SharedWorker"];

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// The page must never see an exception from the bootstrap; only worker constructors throw.
function report(text: string): void {
  console.error(`RECnRun Route C: ${text}`);
}

export function extensionBaseOf(stack: string | undefined): string | undefined {
  return stack === undefined ? undefined : EXTENSION_BASE.exec(stack)?.[0];
}

/** The strategy a strategy file set, removed from the page; anything unknown fails closed. */
export function takeStrategy(scope: object): WorkerStrategy {
  const value: unknown = Reflect.get(scope, STRATEGY_GLOBAL);
  Reflect.deleteProperty(scope, STRATEGY_GLOBAL);
  return WORKER_STRATEGIES.find((strategy) => strategy === value) ?? "fail-closed";
}

/** Whether the original slot file ran, removed from the page like the strategy. */
function takeOriginal(scope: object): boolean {
  const value: unknown = Reflect.get(scope, ORIGINAL_GLOBAL);
  Reflect.deleteProperty(scope, ORIGINAL_GLOBAL);
  return value === true;
}

/** Installs the marker, or the original session's filter; returns why workers must be refused when it could not. */
function bootstrap(scope: object, marker: unknown): string | undefined {
  try {
    installBootstrap(scope, marker === ORIGINAL_SLOT ? { original: true } : { marker });
    return undefined;
  } catch (error) {
    const refusal = `bootstrap failed: ${messageOf(error)}`;
    report(refusal);
    return refusal;
  }
}

function property(scope: object, path: [string, string]): unknown {
  const owner: unknown = Reflect.get(scope, path[0]);
  return isObject(owner) ? Reflect.get(owner, path[1]) : undefined;
}

/** `document.baseURI` in a window, `location.href` in a worker, read when a worker is constructed. */
function baseUrlOf(scope: object): () => string {
  return () => {
    const base = property(scope, ["document", "baseURI"]) ?? property(scope, ["location", "href"]);
    return typeof base === "string" ? base : "";
  };
}

// Captured before page scripts run, so a page that replaces URL.createObjectURL never sees a wrapper.
function objectUrlOf(scope: object): (blob: Blob) => string {
  const owner: unknown = Reflect.get(scope, "URL");
  const create = property(scope, ["URL", "createObjectURL"]);
  return (blob) => {
    if (typeof create !== "function") throw new Error("URL.createObjectURL is unavailable");
    return String(Reflect.apply(create, owner, [blob]));
  };
}

function wrap(scope: object, kind: WorkerKind, context: WorkerContext): void {
  const native: unknown = Reflect.get(scope, kind);
  if (typeof native !== "function") return;
  const own = Object.getOwnPropertyDescriptor(scope, kind);
  Object.defineProperty(scope, kind, {
    value: wrapConstructor(native as new (...args: never[]) => object, kind, context),
    writable: own?.writable ?? true,
    configurable: own?.configurable ?? true,
    enumerable: own?.enumerable ?? false,
  });
}

/** Route C's page bootstrap: the slot's marker on this global, then the worker constructors. */
export function startRouteC(scope: object, stack: string | undefined = new Error().stack): void {
  try {
    const strategy = takeStrategy(scope);
    const marker: unknown = takeOriginal(scope) ? ORIGINAL_SLOT : Reflect.get(scope, MARKER_GLOBAL);
    const refusal = bootstrap(scope, marker);
    const context: WorkerContext = {
      strategy,
      marker: String(marker),
      base: extensionBaseOf(stack),
      ...(refusal === undefined ? {} : { refusal }),
      baseUrl: baseUrlOf(scope),
      createObjectURL: objectUrlOf(scope),
    };
    for (const kind of KINDS) {
      try {
        wrap(scope, kind, context);
      } catch (error) {
        report(`cannot wrap ${kind}: ${messageOf(error)}`);
      }
    }
  } catch (error) {
    report(`failed to start: ${messageOf(error)}`);
  }
}
