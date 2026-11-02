import {
  createServiceClient,
  startService,
  stopOnSignals,
  type ServiceClient,
} from "@recnrun/service";

export interface Connection {
  client: ServiceClient;
  /** False when this process started the service and now owns it. */
  reused: boolean;
  url: string;
  /** Stops the service on SIGTERM or SIGINT, for a process that keeps the service it started. */
  stopOnSignals(): void;
  /** Stops a service this process started; a reused one keeps running. */
  close(): Promise<void>;
}

/** Reuses the service that runs for `home`, or starts one in this process. */
export async function connect(home: string): Promise<Connection> {
  const started = await startService({ home });
  if (started.reused) {
    const { port, token } = started.state;
    return {
      client: createServiceClient({ port, token }),
      reused: true,
      url: `http://127.0.0.1:${port}/`,
      stopOnSignals: () => undefined,
      close: async () => undefined,
    };
  }
  const { service } = started;
  return {
    client: createServiceClient(service),
    reused: false,
    url: `${service.url}/`,
    stopOnSignals: () => stopOnSignals(service),
    close: () => service.stop(),
  };
}
