import { render } from "preact";
import * as v from "valibot";
import { browser } from "wxt/browser";
import { disallowedAncestor } from "@/config/origins";
import { Dashboard, Refusal } from "@/dashboard/Dashboard";
import { initialRoute } from "@/dashboard/route";
import { locationMessage, RouteMessageSchema } from "@/messaging/frame-protocol";
import { readSnapshot } from "@/storage/snapshot-repository";

function routeSubscription(parentOrigin: string | undefined) {
  return (listener: (path: string) => void) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== parentOrigin) return;
      const parsed = v.safeParse(RouteMessageSchema, event.data);
      if (parsed.success) listener(parsed.output.path);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  };
}

export function startDashboard(root: HTMLElement): void {
  const ancestors = [...location.ancestorOrigins];
  const blocked = disallowedAncestor(ancestors, import.meta.env.MODE);
  if (blocked !== undefined) {
    render(<Refusal origin={blocked} />, root);
    return;
  }
  const parentOrigin = ancestors[0];
  render(
    <Dashboard
      loadSnapshot={readSnapshot}
      initialRoute={initialRoute(location.search)}
      subscribeRoute={routeSubscription(parentOrigin)}
      onLocation={(path, title) => {
        if (parentOrigin) window.parent.postMessage(locationMessage(path, title), parentOrigin);
      }}
      openInTab={() => void browser.tabs.create({ url: "/dashboard.html" })}
    />,
    root,
  );
}
