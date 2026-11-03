import { byTestId, count, onClick, show, start } from "../fixture.js";

// `?count=<n>` sets how many input events one click dispatches, in one task.
const total = Number(new URLSearchParams(location.search).get("count") ?? 1000);
const input = byTestId("burst-input");

onClick("burst-button", "bursts", () => {
  for (let index = 0; index < total; index += 1) {
    input.value = String(index);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  show("burst-log", `Dispatched ${total} input events`);
  count("dispatched");
});

await start("burst", { counters: ["bursts", "dispatched"] });
