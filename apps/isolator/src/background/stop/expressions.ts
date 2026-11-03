import type { ClientAction } from "@/background/stop/requests";

// Fixed expressions only: the harness picks an action, never the code that runs in a page or worker.

/** How long a client waits for the worker's reply to a message, inside the page. */
const REPLY_WAIT_MS = 5_000;

export const UNREGISTER =
  'navigator.serviceWorker.getRegistration().then((r) => (r ? r.unregister() : "no registration"))';

/** In the worker: every window client, navigated away from the scope, or why it could not be. */
export const EVICT = `(async () => {
  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
  return Promise.all(windows.map(async (client) => {
    const url = client.url;
    try {
      await client.navigate("about:blank");
      return { url, navigated: true };
    } catch (error) {
      return { url, error: \`\${error.name}: \${error.message}\` };
    }
  }));
})()`;

const STATUS = `(async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  const script = (worker) => worker?.scriptURL ?? null;
  return {
    controller: script(navigator.serviceWorker.controller),
    registration: registration
      ? {
          scope: registration.scope,
          active: script(registration.active),
          waiting: script(registration.waiting),
          installing: script(registration.installing),
        }
      : null,
    syncTags: registration?.sync ? await registration.sync.getTags() : null,
  };
})()`;

const POST_MESSAGE = `(async () => {
  if (!navigator.serviceWorker.controller) return { error: "no controller" };
  const reply = new Promise((resolve) => {
    navigator.serviceWorker.addEventListener("message", (event) => resolve(event.data), { once: true });
  });
  navigator.serviceWorker.startMessages();
  const sentAt = performance.now();
  navigator.serviceWorker.controller.postMessage("report");
  const late = new Promise((resolve) => {
    setTimeout(() => resolve({ error: "no reply within ${REPLY_WAIT_MS} ms" }), ${REPLY_WAIT_MS});
  });
  const answer = await Promise.race([reply, late]);
  return { reply: answer, replyMs: performance.now() - sentAt };
})()`;

const UPDATE = `(async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return { error: "no registration" };
  try {
    await registration.update();
    return { updated: true };
  } catch (error) {
    return { error: \`\${error.name}: \${error.message}\` };
  }
})()`;

function sync(tag: string): string {
  const name = JSON.stringify(tag);
  return `(async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration?.sync) return { error: "no registration with sync" };
  try {
    await registration.sync.register(${name});
  } catch (error) {
    return { error: \`\${error.name}: \${error.message}\` };
  }
  return { registered: ${name}, tags: await registration.sync.getTags() };
})()`;
}

export function clientExpression(request: ClientAction): string {
  switch (request.action) {
    case "status":
      return STATUS;
    case "post-message":
      return POST_MESSAGE;
    case "update":
      return UPDATE;
    case "sync":
      return sync(request.tag);
  }
}
