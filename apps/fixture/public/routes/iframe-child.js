import { onClick, show, start } from "../fixture.js";

show("origin", location.origin);
onClick("child-button", "clicks", () => show("origin", `${location.origin} (clicked)`));

await start("iframe-child", { counters: ["clicks"] });
if (window.parent !== window) window.parent.postMessage({ type: "fixture-child" }, "*");
