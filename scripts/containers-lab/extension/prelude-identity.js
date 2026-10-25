// The prelude's parts for workers and cookies, a classic script that runs after prelude.js. Each
// part is self-contained, as in prelude.js.
(() => {
  /** One shared worker per container and name; service workers are off in containers (S1). */
  function workersPart(ns) {
    if (ns.control) return;
    if (typeof SharedWorker !== "undefined") {
      const Raw = SharedWorker;
      globalThis.SharedWorker = class SharedWorker extends Raw {
        constructor(url, options) {
          const named = typeof options === "object" && options !== null;
          const name = ns.wrap((named ? options.name : options) ?? "");
          super(url, named ? { ...options, name } : name);
          ns.report({ type: "shared-worker", name, url: new URL(url, location.href).href });
        }
      };
    }
    if (typeof ServiceWorkerContainer === "undefined") return;
    const proto = ServiceWorkerContainer.prototype;
    proto.register = () =>
      Promise.reject(new DOMException("Service workers are off in containers.", "SecurityError"));
    proto.getRegistration = () => Promise.resolve(undefined);
    proto.getRegistrations = () => Promise.resolve([]);
    Object.defineProperty(proto, "controller", { get: () => null, configurable: true });
    Object.defineProperty(proto, "ready", { get: () => new Promise(() => {}), configurable: true });
  }

  /** `document.cookie` over a snapshot of the container's script-visible cookies. */
  function cookiesPart(ns) {
    if (typeof Document === "undefined" || ns.control) return;
    const site = (host) => host.split(".").slice(-2).join(".");
    const origins = location.ancestorOrigins;
    const top =
      origins.length > 0 ? new URL(origins[origins.length - 1]).hostname : location.hostname;
    const crossSite = site(top) !== site(location.hostname);
    const pathOk = (path) =>
      location.pathname === path ||
      location.pathname.startsWith(path.endsWith("/") ? path : `${path}/`);
    const applies = (cookie) =>
      (cookie.hostOnly
        ? location.hostname === cookie.domain
        : `.${location.hostname}`.endsWith(`.${cookie.domain}`)) &&
      pathOk(cookie.path) &&
      (cookie.expires === undefined || cookie.expires > Date.now()) &&
      (!crossSite || cookie.sameSite === "none");
    const read = () =>
      ns.cookies
        .filter(applies)
        .toSorted((a, b) => b.path.length - a.path.length)
        .map(({ name, value }) => `${name}=${value}`)
        .join("; ");
    const write = (header) => {
      const [pair = "", ...attributes] = String(header).split(";");
      const name = pair.slice(0, Math.max(pair.indexOf("="), 0)).trim();
      const expired = attributes.some((part) => /^\s*max-age\s*=\s*(-|0)/i.test(part));
      const path =
        attributes.map((part) => /^\s*path\s*=\s*(\S+)/i.exec(part)?.[1]).find(Boolean) ?? "/";
      const rest = ns.cookies.filter((cookie) => cookie.name !== name || cookie.path !== path);
      const value = pair.slice(pair.indexOf("=") + 1).trim();
      ns.cookies = expired
        ? rest
        : [
            ...rest,
            { name, value, domain: location.hostname, hostOnly: true, path, sameSite: "lax" },
          ];
      ns.report({ type: "cookie", header: String(header), url: location.href });
    };
    Object.defineProperty(Document.prototype, "cookie", {
      get: read,
      set: write,
      configurable: true,
    });
    delete globalThis.cookieStore;
  }

  globalThis.rnrPrelude.parts.push(workersPart, cookiesPart);
})();
