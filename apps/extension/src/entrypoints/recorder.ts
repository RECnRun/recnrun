import { defineContentScript } from "wxt/utils/define-content-script";
import { recorderMatches } from "@/config/origins";
import { startRecorder } from "@/recorder/start";

export default defineContentScript({
  // Registered at run time for the origins the user allowed; the test build pre-grants localhost.
  registration: "runtime",
  matches: recorderMatches(import.meta.env.MODE),
  main: startRecorder,
});
