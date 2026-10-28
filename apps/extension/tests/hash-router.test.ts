import { expect, test } from "vite-plus/test";
import { createHashRouter } from "@/dashboard/hash-router";

/** A dashboard tab stand-in: its address's hash, its history, and its title. */
function tabPage(hash: string) {
  const pushed: string[] = [];
  const page = Object.assign(new EventTarget(), {
    location: { hash },
    history: {
      pushState(_state: unknown, _unused: string, url: string) {
        pushed.push(url);
        page.location.hash = url;
      },
    },
    document: { title: "" },
  });
  /** The address bar moving to `next`, as Back or an edited address does. */
  const move = (next: string) => {
    page.location.hash = next;
    page.dispatchEvent(new Event("hashchange"));
  };
  return { router: createHashRouter(page as unknown as Window), page, pushed, move };
}

test("starts at the route in the hash, and at the list without one", () => {
  expect(tabPage("#/recordings/rec-login").router.initialRoute).toBe("/recordings/rec-login");
  expect(tabPage("").router.initialRoute).toBe("/");
  expect(tabPage("#").router.initialRoute).toBe("/");
});

test("treats a hash that is not a path as no route at all", () => {
  expect(tabPage("#recordings").router.initialRoute).toBe("/");
  expect(tabPage("#//evil.example/x").router.initialRoute).toBe("/");
});

test("links and navigation stay in the hash, adding one history entry each", () => {
  const { router, page, pushed } = tabPage("");
  expect(router.href("/recordings/rec-login")).toBe("#/recordings/rec-login");
  router.navigate("/recordings/rec-login");
  expect(pushed).toEqual(["#/recordings/rec-login"]);
  expect(page.location.hash).toBe("#/recordings/rec-login");
});

test("follows the hash as Back moves it, until unsubscribed", () => {
  const { router, move } = tabPage("#/recordings/rec-login");
  const seen: string[] = [];
  const stop = router.subscribe((path) => seen.push(path));
  move("");
  move("#//evil.example/x");
  move("#/recordings/rec-checkout");
  stop();
  move("#/");
  expect(seen).toEqual(["/", "/", "/recordings/rec-checkout"]);
});

test("titles the tab itself", () => {
  const { router, page } = tabPage("");
  router.publish("/recordings/rec-login", "Log in as admin · RECnRun");
  expect(page.document.title).toBe("Log in as admin · RECnRun");
});

test("hears a hash that moved between the first render and subscribing", () => {
  const { router, page } = tabPage("");
  page.location.hash = "#/recordings/rec-login";
  const seen: string[] = [];
  router.subscribe((path) => seen.push(path));
  expect(seen).toEqual(["/recordings/rec-login"]);
});
