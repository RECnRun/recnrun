import {
  createServiceClient,
  startService,
  stopOnSignals,
  type ServiceClient,
} from "@recnrun/service";
import { guardSignals } from "./signals.ts";

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

export interface ConnectOptions {
  start?: typeof startService;
  guard?: typeof guardSignals;
  keep?: typeof stopOnSignals;
}

/** Reuses the service that runs for `home`, or starts one in this process. */
export async function connect(home: string, options: ConnectOptions = {}): Promise<Connection> {
  const { start = startService, guard = guardSignals, keep = stopOnSignals } = options;
  const started = await start({ home });
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
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= service.stop());
  // A command that ends on a signal still stops the service it started (exit 130 or 143).
  const signals = guard(stop);
  return {
    client: createServiceClient(service),
    reused: false,
    url: `${service.url}/`,
    stopOnSignals: () => {
      signals.release();
      keep(service);
    },
    close: async () => {
      await stop();
      signals.release();
    },
  };
}
