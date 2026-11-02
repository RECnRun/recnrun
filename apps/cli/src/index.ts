import { createLocalService, type Service } from "@recnrun/service";

export const USAGE = "Usage: recnrun --version";

export type Write = (line: string) => void;

/** Runs the CLI with its arguments and returns the process exit code. */
export function main(
  argv: readonly string[],
  write: Write = (line) => console.log(line),
  service: Service = createLocalService(),
): number {
  if (argv.includes("--version")) {
    write(`RECnRun protocol ${service.health().version}`);
    return 0;
  }
  write(USAGE);
  return 1;
}
