export const USAGE = [
  "Usage: recnrun <command> [options]",
  "",
  "Commands:",
  "  open [--no-browser] [--home <dir>]     Start the local service (or reuse the running one) and print the UI URL",
  "  run --flow <dir|file> [--dataset <name>] [--timeout <seconds>] [--home <dir>]",
  "                                         Replay a flow; prints a JSON summary, exits 0 passed, 1 failed, 2 error",
  "  doctor [--json] [--home <dir>]         Check Node, Chrome, DevToolsActivePort, bindings, disk, and versions",
  "",
  "Options:",
  "  --version, -v                          Print the version",
  "  --help, -h                             Print this help",
].join("\n");

const DEFAULT_TIMEOUT_MS = 600_000;

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "open"; noBrowser: boolean; home: string | undefined }
  | { kind: "doctor"; json: boolean; home: string | undefined }
  | {
      kind: "run";
      flow: string;
      dataset: string | undefined;
      home: string | undefined;
      timeoutMs: number;
    };

export type ParseResult = { ok: true; command: Command } | { ok: false; message: string };

type Flags = Map<string, string | true>;

interface Spec {
  booleans: readonly string[];
  values: readonly string[];
}

const SPECS: Record<string, Spec> = {
  open: { booleans: ["no-browser"], values: ["home"] },
  doctor: { booleans: ["json"], values: ["home"] },
  // --json is accepted for symmetry: the summary on stdout is always JSON.
  run: { booleans: ["json"], values: ["flow", "dataset", "home", "timeout"] },
};

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

type Applied = { ok: true; consumed: number } | { ok: false; message: string };

interface Context {
  name: string;
  spec: Spec;
  flags: Flags;
}

function applyFlag({ name, spec, flags }: Context, arg: string, next: string | undefined): Applied {
  const [flag = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
  if (spec.booleans.includes(flag)) {
    if (inline !== undefined) return fail(`--${flag} takes no value.`);
    flags.set(flag, true);
    return { ok: true, consumed: 0 };
  }
  if (!spec.values.includes(flag)) return fail(`Unknown option "--${flag}" for ${name}.`);
  const value = inline ?? next;
  if (value === undefined || value === "") return fail(`--${flag} needs a value.`);
  flags.set(flag, value);
  return { ok: true, consumed: inline === undefined ? 1 : 0 };
}

function readFlags(name: string, spec: Spec, args: readonly string[]) {
  const context: Context = { name, spec, flags: new Map() };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) return fail(`Unexpected argument "${arg}" for ${name}.`);
    const applied = applyFlag(context, arg, args[index + 1]);
    if (!applied.ok) return applied;
    index += applied.consumed;
  }
  return { ok: true as const, flags: context.flags };
}

const text = (flags: Flags, name: string): string | undefined => {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
};

function buildRun(flags: Flags): ParseResult {
  const flow = text(flags, "flow");
  if (flow === undefined) return fail("run requires --flow <dir|file>.");
  const seconds = text(flags, "timeout");
  const timeoutMs = seconds === undefined ? DEFAULT_TIMEOUT_MS : Number(seconds) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return fail("--timeout needs a positive number of seconds.");
  const dataset = text(flags, "dataset");
  return {
    ok: true,
    command: { kind: "run", flow, dataset, home: text(flags, "home"), timeoutMs },
  };
}

function build(name: string, flags: Flags): ParseResult {
  const home = text(flags, "home");
  if (name === "open")
    return { ok: true, command: { kind: "open", noBrowser: flags.has("no-browser"), home } };
  if (name === "doctor")
    return { ok: true, command: { kind: "doctor", json: flags.has("json"), home } };
  return buildRun(flags);
}

/** Parses `process.argv.slice(2)`; every problem is a message, never a throw. */
export function parseArgs(argv: readonly string[]): ParseResult {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h")
    return { ok: true, command: { kind: "help" } };
  if (first === "--version" || first === "-v") return { ok: true, command: { kind: "version" } };
  const spec = SPECS[first];
  if (spec === undefined) return fail(`Unknown command "${first}".`);
  const read = readFlags(first, spec, rest);
  return read.ok ? build(first, read.flags) : read;
}
