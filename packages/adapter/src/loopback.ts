/** Thrown before any socket opens when an endpoint is not a loopback `ws:` URL. */
export class NonLoopbackEndpointError extends Error {
  readonly code = "non-loopback-endpoint";
  readonly endpoint: string;

  constructor(endpoint: string) {
    super(
      `Refusing ${endpoint}: RECnRun connects only to ws:// on 127.0.0.1, [::1], or localhost.`,
    );
    this.name = "NonLoopbackEndpointError";
    this.endpoint = endpoint;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** True only for a plain `ws:` URL on a loopback host; `wss:`, `0.0.0.0`, and user info are refused. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  return (
    url.protocol === "ws:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password
  );
}

export function assertLoopbackEndpoint(endpoint: string): void {
  if (!isLoopbackEndpoint(endpoint)) throw new NonLoopbackEndpointError(endpoint);
}
