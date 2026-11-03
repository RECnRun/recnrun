import { onClick, start } from "../fixture.js";

// Larger than the capture keeps, so the journal shows what its limits cut.
const largeValues = () => [
  "Fixture values",
  {
    ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`p${index}`, index])),
    child: { deep: { deeper: 1 } },
  },
  "y".repeat(5000),
  Array.from({ length: 150 }, (_, index) => index),
  new Map([["key", { a: 1 }]]),
];

function innerLog() {
  console.log(...largeValues());
}

function outerLog() {
  innerLog();
}

function innerThrow() {
  throw new Error("Thrown from a nested call");
}

function outerThrow() {
  innerThrow();
}

const ACTIONS = {
  log: () => console.log("Fixture log message"),
  warn: () => console.warn("Fixture warning"),
  error: () => console.error("Fixture error message"),
  throw: () => {
    throw new Error("Uncaught on purpose");
  },
  // Left unhandled on purpose, so the page reports an unhandled rejection.
  reject: () => void Promise.reject(new Error("Rejected on purpose")),
  values: outerLog,
  "throw-nested": outerThrow,
};

for (const [name, action] of Object.entries(ACTIONS)) onClick(name, name, action);

await start("console", { counters: Object.keys(ACTIONS) });
