import { byTestId, count, show, start } from "../fixture.js";

const EVENTS = ["compositionstart", "compositionupdate", "compositionend"];
const input = byTestId("ime-input");
const sequence = [];

for (const type of EVENTS) {
  input.addEventListener(type, () => {
    count(type);
    // Consecutive updates collapse, so the shown sequence does not depend on the IME's pace.
    if (sequence.at(-1) !== type) sequence.push(type);
    show("ime-log", sequence.join(", "));
  });
}

await start("ime", { counters: EVENTS });
