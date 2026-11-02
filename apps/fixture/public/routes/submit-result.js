import { show, start } from "../fixture.js";

const name = new URLSearchParams(location.search).get("name");
show("result", name ? `Received ${name}` : "Received nothing");

await start("submit-result");
