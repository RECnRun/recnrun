import { onClick, show, start } from "../fixture.js";

onClick("alert", "alerts", () => {
  alert("Fixture alert");
  show("dialog-outcome", "alert closed");
});

onClick("confirm", "confirms", () => {
  show("dialog-outcome", confirm("Continue?") ? "confirmed" : "cancelled");
});

await start("dialogs", { counters: ["alerts", "confirms"] });
