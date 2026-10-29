import * as v from "valibot";
import {
  PORT_OFFER_EVENT,
  RELAY_READY_EVENT,
  ResponseUrlPairsSchema,
} from "@/messaging/response-url-protocol";

type Lookup = Promise<ReadonlyMap<string, string>>;
type Method = (...args: never[]) => unknown;
/** A native method, called with the object it was read from. */
type Native<F extends Method> = (this: unknown, ...args: Parameters<F>) => ReturnType<F>;

/** How long the page waits for the relay's URLs before it reads every response natively. */
const RELAY_BOUND_MS = 3_000;

/**
 * Offers the relay a port while both run at document_start, before any page script: the events
 * dispatch synchronously, and the listeners are gone once the relay took it, so the page never sees
 * the port. Resolves with the URLs the relay sends, or none in time.
 */
export function receiveUrls(target: EventTarget, boundMs = RELAY_BOUND_MS): Lookup {
  const channel = new MessageChannel();
  const offer = () =>
    !target.dispatchEvent(
      new MessageEvent(PORT_OFFER_EVENT, { ports: [channel.port2], cancelable: true }),
    );
  const onReady = () => {
    if (offer()) target.removeEventListener(RELAY_READY_EVENT, onReady);
  };
  if (!offer()) target.addEventListener(RELAY_READY_EVENT, onReady);
  return new Promise((resolve) => {
    const done = (data: unknown) => {
      clearTimeout(timer);
      target.removeEventListener(RELAY_READY_EVENT, onReady);
      channel.port1.close();
      resolve(new Map(v.is(ResponseUrlPairsSchema, data) ? data : []));
    };
    const timer = setTimeout(() => done([]), boundMs);
    channel.port1.onmessage = ({ data }) => done(data);
  });
}

/** The native accessor or method `key` of `proto`, read off its descriptor to call it later. */
function nativeOf<F>(proto: object, key: string, part: "get" | "value"): F | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(proto, key);
  return descriptor === undefined ? undefined : (Reflect.get(descriptor, part) as F);
}

/** A patched function keeps the native one's name and length. */
function shaped<F extends Method>(patched: F, native: Method): F {
  Object.defineProperty(patched, "name", { value: native.name });
  Object.defineProperty(patched, "length", { value: native.length });
  return patched;
}

/** Shows a response read without a URL with the one its request's entry was fetched from. */
function shower(shown: WeakMap<Response, string>, urls: Lookup) {
  return async (response: Response | undefined, request: Request | undefined) => {
    if (response === undefined || request === undefined || response.url !== "") return;
    const url = (await urls).get(request.url);
    if (url !== undefined) shown.set(response, url);
  };
}

function patchResponse(proto: Response, shown: WeakMap<Response, string>): void {
  const native = nativeOf<Native<() => string>>(proto, "url", "get");
  const nativeClone = nativeOf<Native<Response["clone"]>>(proto, "clone", "value");
  if (native === undefined || nativeClone === undefined) return;
  const patched = {
    get url() {
      const response = this as unknown as Response;
      return shown.get(response) ?? native.call(response);
    },
  };
  const get = nativeOf<() => string>(patched, "url", "get");
  Object.defineProperty(proto, "url", {
    get,
    set: undefined,
    enumerable: true,
    configurable: true,
  });
  proto.clone = shaped(function clone(this: Response) {
    const copy = nativeClone.call(this);
    const url = shown.get(this);
    if (url !== undefined) shown.set(copy, url);
    return copy;
  }, nativeClone);
}

function patchCache(proto: Cache, show: ReturnType<typeof shower>): void {
  const nativeMatch = nativeOf<Native<Cache["match"]>>(proto, "match", "value");
  const nativeMatchAll = nativeOf<Native<Cache["matchAll"]>>(proto, "matchAll", "value");
  const keys = nativeOf<Native<Cache["keys"]>>(proto, "keys", "value");
  if (nativeMatch === undefined || nativeMatchAll === undefined || keys === undefined) return;
  // Read in the same turn, the keys come back in the order the responses do.
  proto.match = shaped(async function match(this: Cache, ...args: Parameters<Cache["match"]>) {
    const read = [nativeMatch.call(this, ...args), keys.call(this, ...args)] as const;
    const [response, [request]] = await Promise.all(read);
    await show(response, request);
    return response;
  }, nativeMatch);
  proto.matchAll = shaped(async function matchAll(
    this: Cache,
    ...args: Parameters<Cache["matchAll"]>
  ) {
    const read = [nativeMatchAll.call(this, ...args), keys.call(this, ...args)] as const;
    const [responses, requests] = await Promise.all(read);
    if (responses.length === requests.length) {
      await Promise.all(responses.map((response, at) => show(response, requests[at])));
    }
    return responses;
  }, nativeMatchAll);
}

/** The first cache's request that matches, searched as `CacheStorage.match` searches them. */
async function keyIn(
  storage: CacheStorage,
  ...[request, options]: Parameters<CacheStorage["match"]>
) {
  const names = options?.cacheName === undefined ? await storage.keys() : [options.cacheName];
  for (const name of names) {
    if (!(await storage.has(name))) continue;
    const [key] = await (await storage.open(name)).keys(request, options);
    if (key !== undefined) return key;
  }
  return undefined;
}

function patchStorage(proto: CacheStorage, show: ReturnType<typeof shower>): void {
  const native = nativeOf<Native<CacheStorage["match"]>>(proto, "match", "value");
  if (native === undefined) return;
  proto.match = shaped(async function match(
    this: CacheStorage,
    ...args: Parameters<CacheStorage["match"]>
  ) {
    const response = await native.call(this, ...args);
    if (response?.url === "") await show(response, await keyIn(this, ...args));
    return response;
  }, native);
}

/**
 * Shows each restored cache entry with the URL it was fetched from, which a constructed `Response`
 * cannot carry: only a response read without a URL, under a request URL the relay named, changes.
 */
function patchResponseUrls(scope: typeof globalThis, urls: Lookup): void {
  const shown = new WeakMap<Response, string>();
  const show = shower(shown, urls);
  patchResponse(scope.Response.prototype, shown);
  patchCache(scope.Cache.prototype, show);
  patchStorage(scope.CacheStorage.prototype, show);
}

/** Cache Storage exists only in a secure context, so elsewhere there is nothing to show. */
export function startResponseUrlPage(): void {
  if (!isSecureContext) return;
  patchResponseUrls(globalThis, receiveUrls(document));
}
