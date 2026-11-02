import type { ProbeTargets } from "@/background/probes/types";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/** R11 (POC PLAN.md §1): an http(s) URL on the loopback, which Chrome resolves *.localhost to. */
function isLoopbackUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol, hostname } = new URL(value);
  if (protocol !== "http:" && protocol !== "https:") return false;
  return LOOPBACK_HOSTS.includes(hostname) || hostname.endsWith(".localhost");
}

/** The harness passes the fixture URLs; the probes hand them to Chrome, so only the loopback passes. */
export function assertLoopbackTargets(urls: ProbeTargets): void {
  const outside = Object.entries(urls).filter(([, url]) => !isLoopbackUrl(String(url)));
  if (outside.length === 0) return;
  const list = outside.map(([key, url]) => `${key}=${String(url)}`).join(", ");
  throw new Error(`probe targets outside the loopback: ${list}`);
}
