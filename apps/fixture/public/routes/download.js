import { onClick, start } from "../fixture.js";

// The link's download attribute and the server's attachment header both trigger the download.
onClick("download", "downloads", () => {});

await start("download", { counters: ["downloads"] });
