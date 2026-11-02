import { byTestId, count, failCase, show, start } from "../fixture.js";

const form = byTestId("form");

function describe(data) {
  // ?fail=status changes only the name, so exactly a status assertion fails.
  const name = failCase === "status" ? "nobody" : String(data.get("name") ?? "");
  const file = data.get("attachment");
  const fileName = file instanceof File && file.name ? file.name : "no file";
  const terms = data.get("terms") ? "terms accepted" : "terms declined";
  const contact = data.get("contact") ?? "no contact";
  return `Submitted ${name} (${data.get("plan")}, ${contact}, ${terms}, ${fileName})`;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  count("submits");
  show("status", describe(new FormData(form)));
});

await start("form", { counters: ["submits"] });
