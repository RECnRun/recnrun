/** Exit codes of a CLI command a signal ended while it owned the service: 128 + the signal number. */
export const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

type SignalSource = {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
};

/**
 * Until `release`, SIGINT or SIGTERM runs `stop` and then exits with the signal's code, since
 * default signal termination skips every `finally` that would stop a service this process owns.
 */
export function guardSignals(
  stop: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
  source: SignalSource = process,
) {
  let stopping = false;
  const listeners = Object.entries(SIGNAL_EXIT_CODES).map(([signal, code]) => {
    const listener = () => {
      if (stopping) return;
      stopping = true;
      stop().then(
        () => exit(code),
        () => exit(code),
      );
    };
    source.once(signal, listener);
    return { signal, listener };
  });
  return {
    release: () => {
      for (const { signal, listener } of listeners) source.off(signal, listener);
    },
  };
}
