import { byTestId, count, start } from "../fixture.js";

// The browser posts the form itself; the server answers 303 to /routes/submit-result.
byTestId("form").addEventListener("submit", () => count("submits"));

await start("submit-redirect", { counters: ["submits"] });
