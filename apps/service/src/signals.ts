import type { RunningService } from "./service.ts";

interface SignalSource {
  once(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

/** On `SIGTERM` or `SIGINT`, stops the service (draining its journals) and then exits. */
export function stopOnSignals(
  service: Pick<RunningService, "stop">,
  exit: (code: number) => void = (code) => process.exit(code),
  source: SignalSource = process,
): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    service.stop().then(
      () => exit(0),
      () => exit(1),
    );
  };
  source.once("SIGTERM", stop);
  source.once("SIGINT", stop);
}
