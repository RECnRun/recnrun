import type { RotatingLog } from "@recnrun/persistence";

type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

/** Structured JSON lines: `time`, `level`, `event`, `pid`, then the event's fields. */
export interface Logger {
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  /** Waits for every line logged so far. */
  close(): Promise<void>;
}

/** Writes through `log`; a failed write never reaches the caller, since logging must not stop the API. */
export function createLogger(log: RotatingLog, now: () => Date = () => new Date()): Logger {
  const write =
    (level: Level) =>
    (event: string, fields: Fields = {}) => {
      const record = { time: now().toISOString(), level, event, pid: process.pid, ...fields };
      void log.append(`${JSON.stringify(record)}\n`).catch(() => undefined);
    };
  return {
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    close: () => log.close(),
  };
}
