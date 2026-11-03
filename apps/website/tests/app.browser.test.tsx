import { render } from "preact";
import { expect, test } from "vite-plus/test";
import { App } from "@/app/App";
import {
  MACOS_PERMISSION_STEP,
  OPEN_COMMAND,
  SETUP_COMMAND,
} from "@/features/install-guide/InstallGuide";

function mount() {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  render(<App />, root);
  return root;
}

test("introduces RECnRun as a local tool that drives Chrome over CDP without AI", () => {
  const root = mount();
  expect(root.querySelector("h1")?.textContent).toBe("RECnRun");
  const lead = root.querySelector(".lead")?.textContent ?? "";
  expect(lead).toContain("Chrome DevTools Protocol");
  expect(lead).toContain("no AI");
});

test("lists the setup and open commands in order", () => {
  const root = mount();
  const install = root.querySelector('section[aria-labelledby="install-title"]');
  expect(install?.querySelector("h2")?.textContent).toBe("Install");
  const commands = [...(install?.querySelectorAll("li pre code") ?? [])].map((c) => c.textContent);
  expect(commands).toEqual([SETUP_COMMAND, OPEN_COMMAND]);
  expect(SETUP_COMMAND).toBe("npx @recnrun/cli setup");
  expect(OPEN_COMMAND).toBe("npx @recnrun/cli open");
});

test("tells macOS users to let the terminal read Chrome's data", () => {
  const install = mount().querySelector(".install");
  expect(install?.textContent).toContain(MACOS_PERMISSION_STEP);
  expect(MACOS_PERMISSION_STEP).toContain("Full Disk Access");
  expect(MACOS_PERMISSION_STEP).toContain("access data from other apps");
});

test("says the package is not published yet", () => {
  expect(mount().querySelector(".install")?.textContent).toContain("not published yet");
});
