import { byTestId, count, show, start } from "../fixture.js";

function render() {
  const view = new URLSearchParams(location.search).get("view") === "b" ? "B" : "A";
  show("view", `View ${view}`);
}

for (const testId of ["link-a", "link-b"]) {
  const link = byTestId(testId);
  link.addEventListener("click", (event) => {
    event.preventDefault();
    history.pushState({}, "", link.href);
    count("navigations");
    render();
  });
}

window.addEventListener("popstate", () => {
  count("popstates");
  render();
});

render();
await start("spa", { counters: ["navigations", "popstates"] });
