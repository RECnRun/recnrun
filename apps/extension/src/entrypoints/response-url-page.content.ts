import { defineContentScript } from "wxt/utils/define-content-script";
import { startResponseUrlPage } from "@/origin/response-url-page";

// Registered at run time, in the page's world, on the origins whose restored caches were fetched.
export default defineContentScript({
  registration: "runtime",
  world: "MAIN",
  main: startResponseUrlPage,
});
