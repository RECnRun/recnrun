import { homedir } from "node:os";
import { loadFlowFile } from "@recnrun/service";
import { parseArgs, USAGE, type Command } from "./args.ts";
import { connect, type Connection } from "./connect.ts";
import { loadDataset } from "./dataset.ts";
import { assembleReport, doctorExitCode, formatReport } from "./doctor.ts";
import { machineProbes, openUrl } from "./probes.ts";
import { runFlow } from "./run.ts";
import { CLI_VERSION } from "./version.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** The user's home folder, where `.recnrun` lives; `--home` overrides it. */
  home: string;
}

export interface Deps {
  connect(home: string): Promise<Connection>;
  openUrl(url: string): Promise<void>;
}

const realIo = (): Io => ({
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  home: homedir(),
});

const realDeps: Deps = { connect, openUrl };

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function open(command: Extract<Command, { kind: "open" }>, io: Io, deps: Deps) {
  const connection = await deps.connect(command.home ?? io.home);
  io.out(connection.url);
  // A service this process started lives until a signal; one that was running is left alone.
  if (!connection.reused) connection.stopOnSignals();
  if (!command.noBrowser) {
    await deps.openUrl(connection.url).catch((error: unknown) => {
      io.err(`Could not open a browser: ${describe(error)}. Open ${connection.url} yourself.`);
    });
  }
  return 0;
}

async function doctor(command: Extract<Command, { kind: "doctor" }>, io: Io, deps: Deps) {
  const home = command.home ?? io.home;
  // Chrome comes from the service's `health`, so a running service is reused and none is started for good.
  const connection = await deps.connect(home);
  try {
    const report = await assembleReport(machineProbes(home, connection));
    for (const line of command.json ? [JSON.stringify(report)] : formatReport(report)) io.out(line);
    return doctorExitCode(report);
  } finally {
    await connection.close();
  }
}

async function dispatch(command: Command, io: Io, deps: Deps): Promise<number> {
  switch (command.kind) {
    case "help":
      io.out(USAGE);
      return 0;
    case "version":
      io.out(`recnrun ${CLI_VERSION}`);
      return 0;
    case "open":
      return open(command, io, deps);
    case "doctor":
      return doctor(command, io, deps);
    case "run": {
      const home = command.home ?? io.home;
      return runFlow(command, {
        load: loadFlowFile,
        loadDataset,
        connect: () => deps.connect(home),
        out: (line) => io.out(line),
        err: (line) => io.err(line),
        pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: Date.now,
      });
    }
  }
}

/** Runs the CLI and returns the process exit code: 0 ok, 1 not ok (failed run, no Chrome), 2 error. */
export async function main(
  argv: readonly string[],
  io: Io = realIo(),
  deps: Deps = realDeps,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.err(parsed.message);
    io.err(USAGE);
    return 2;
  }
  try {
    return await dispatch(parsed.command, io, deps);
  } catch (error) {
    io.err(`recnrun failed: ${describe(error)}`);
    return 2;
  }
}
