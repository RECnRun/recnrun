import { render } from "preact";
import { afterEach } from "vite-plus/test";
import { Dashboard } from "@/dashboard/Dashboard";
import type { DashboardRouter } from "@/dashboard/router";
import type { WorkspaceStatus } from "@/messaging/workspace-protocol";
import type { OpenTab } from "@/ports/tabs";
import type { PageRequest } from "@/views/extension-services";
import { fakeBackground, fakeExtension } from "./fake-extension";
import { fakeHistory } from "./fake-history";
import { memoryOperationJournal } from "./fake-journal";
import { PRIVATE, SHOP, fakeIncognito, fakeTabs } from "./fake-tabs";
import { button } from "./queries";

const router: DashboardRouter = {
  initialRoute: "/",
  href: (path) => path,
  subscribe: () => () => {},
  navigate: () => {},
  publish: () => {},
};

/** Answers a request itself, or returns undefined to leave it to the fake background. */
export type Answer = (request: PageRequest) => Promise<unknown> | undefined;

let mounted: HTMLElement | undefined;

afterEach(() => {
  if (mounted) render(null, mounted);
  mounted = undefined;
});

/** Renders the dashboard over a fake background that answers `workspace-status` with the status set. */
export function mount(
  initial: WorkspaceStatus,
  answer: Answer = () => undefined,
  tabs: OpenTab[] = [SHOP, PRIVATE],
  history = fakeHistory(),
) {
  let status = initial;
  let reads = 0;
  const background = fakeBackground(() => {
    reads += 1;
    return status;
  });
  const incognito = fakeIncognito(initial.access);
  const send = (request: PageRequest) => answer(request) ?? background.send(request);
  const operations = memoryOperationJournal();
  const services = fakeExtension({
    send,
    operations,
    incognito: incognito.access,
    tabs: fakeTabs({ tabs }).source,
    history: history.source,
  });
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  mounted = root;
  render(<Dashboard services={services} router={router} take={async () => {}} />, root);
  const setStatus = (next: WorkspaceStatus) => {
    status = next;
  };
  return { root, sent: background.sent, reads: () => reads, setStatus, incognito, operations };
}

export const panel = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('section[aria-labelledby="incognito-workspace-heading"]') ??
  undefined;
export const panelText = (root: HTMLElement) => panel(root)?.textContent ?? "";
export const inPanel = (root: HTMLElement, name: string) => button(panel(root) ?? root, name);
export const row = (root: HTMLElement, title: string) =>
  root.querySelector<HTMLElement>(`li[aria-label="${title}"]`) ?? root;

/** Types the address and waits for the render that gives the buttons the new value. */
export async function typeAddress(root: HTMLElement, url: string) {
  const input = panel(root)?.querySelector("input");
  if (!input) throw new Error("No address field");
  input.value = url;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The panel's alerts, in order; the panel keeps at most one. */
export const alertText = (root: HTMLElement) =>
  [...(panel(root)?.querySelectorAll('[role="alert"]') ?? [])].map((each) => each.textContent);

/** The names of the panel's buttons a click would reach. */
export const enabledButtons = (root: HTMLElement) =>
  [...(panel(root)?.querySelectorAll("button") ?? [])]
    .filter((each) => !each.disabled)
    .map((each) => each.textContent);
