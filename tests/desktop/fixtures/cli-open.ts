// The real CLI, `recnrun open --no-browser --home <tmp>`, run as a person runs it.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromeEnv } from "./person-chrome.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface CliOpen {
  /** The UI URL the command printed. */
  readonly url: string;
  /** Sends SIGTERM and resolves with the exit code or signal. */
  stop(): Promise<string>;
}

/** Starts the service through the CLI and waits for the URL it prints. */
export async function cliOpen(home: string): Promise<CliOpen> {
  const args = [join(ROOT, "apps/cli/src/bin.ts"), "open", "--no-browser", "--home", home];
  const child = spawn(process.execPath, args, {
    env: chromeEnv(home),
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<string>((resolve) =>
    child.once("exit", (code, signal) => resolve(String(code ?? signal))),
  );
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done === true) throw new Error("recnrun open exited before printing the UI URL.");
  const url = String(first.value).trim();
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) throw new Error(`Unexpected URL: ${url}`);
  return {
    url,
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      return exited;
    },
  };
}
