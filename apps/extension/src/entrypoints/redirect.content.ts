import { defineContentScript } from "wxt/utils/define-content-script";
import { contentScriptMatches } from "@/config/origins";
import { startRedirect } from "@/content/redirect";

export default defineContentScript({
  matches: contentScriptMatches(import.meta.env.MODE),
  // Runs before the site renders, to keep the flash of the site short.
  runAt: "document_start",
  main: startRedirect,
});
