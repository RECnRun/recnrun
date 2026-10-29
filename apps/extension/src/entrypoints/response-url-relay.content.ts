import { defineContentScript } from "wxt/utils/define-content-script";
import { startResponseUrlRelay } from "@/origin/response-url-relay";

// Registered beside the page script: it hands the page script the URLs the background keeps.
export default defineContentScript({
  registration: "runtime",
  main: startResponseUrlRelay,
});
