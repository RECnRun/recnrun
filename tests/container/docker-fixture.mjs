import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const directory = process.env.DOCKER_FIXTURE_DIR;
appendFileSync(join(directory, "calls.jsonl"), `${JSON.stringify(args)}\n`);
const scenario = process.env.DOCKER_FIXTURE_SCENARIO;
const command = args[0];

if (command === "info" && scenario === "unavailable") {
  console.error("Cannot connect to the Docker daemon");
  process.exit(1);
}
if (command === "build") {
  if (scenario === "build-failure") process.exit(3);
  writeFileSync(args[args.indexOf("--iidfile") + 1], "sha256:fixture-image\n");
  if (scenario === "blocked-export") {
    writeFileSync(join(dirname(args[args.indexOf("--iidfile") + 1]), "coverage"), "Blocked");
  }
}
if (command === "create") console.log("fixture-container");
if (command === "start") {
  console.log("Container test output");
  console.error("Container diagnostic output");
  if (scenario === "interrupt") {
    const timer = setInterval(() => {
      if (existsSync(join(directory, "stopped"))) {
        clearInterval(timer);
        process.exit(0);
      }
    }, 20);
  }
}
if (command === "stop") writeFileSync(join(directory, "stopped"), "stopped");
if (command === "wait") {
  console.log(scenario === "empty-exit" ? "" : scenario === "test-failure" ? "7" : "0");
}
if (command === "cp") {
  if (scenario === "copy-failure") process.exit(1);
  const destination = args.at(-1);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "evidence.txt"), "Test evidence");
}
