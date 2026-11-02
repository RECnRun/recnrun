import { onClick, start } from "../fixture.js";

const ACTIONS = {
  log: () => console.log("Fixture log message"),
  warn: () => console.warn("Fixture warning"),
  error: () => console.error("Fixture error message"),
  throw: () => {
    throw new Error("Uncaught on purpose");
  },
  // Left unhandled on purpose, so the page reports an unhandled rejection.
  reject: () => void Promise.reject(new Error("Rejected on purpose")),
};

for (const [name, action] of Object.entries(ACTIONS)) onClick(name, name, action);

await start("console", { counters: Object.keys(ACTIONS) });
