import { byTestId, start } from "../fixture.js";

/** Logged only if a viewer runs the captured page's script; this page never runs it. */
export const VIEWER_MARKER = "recnrun-viewer-marker";

// Scripts inserted with innerHTML never run here, yet a snapshot serializes them as written.
byTestId("hostile").innerHTML = [
  `<script>console.log("${VIEWER_MARKER}: inline script ran")</script>`,
  `<script src="http://remote.example/viewer.js"></script>`,
  `<img alt="Remote pixel" data-testid="remote-image" src="http://remote.example/pixel.png" />`,
  `<form action="http://remote.example/collect" method="post" data-testid="remote-form">`,
  `<input name="note" value="captured" aria-label="Note" data-testid="remote-note" />`,
  `<button type="submit" data-testid="remote-submit">Send</button>`,
  `</form>`,
].join("");

await start("hostile");
