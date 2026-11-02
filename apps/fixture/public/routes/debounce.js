import { byTestId, count, show, start } from "../fixture.js";

const QUIET_MS = 300;
const input = byTestId("query");
let timer;

input.addEventListener("input", () => {
  count("inputs");
  clearTimeout(timer);
  timer = setTimeout(() => {
    count("debounced");
    show("debounced", `Debounced: ${input.value}`);
  }, QUIET_MS);
});

await start("debounce", { counters: ["inputs", "debounced"] });
