import type { Page } from "@playwright/test";

type Envelope = { ok: boolean; result?: unknown; error?: { message: string } };

/** Sends one command as the served UI does, with the token the service put in the page. */
export async function uiCommand<T = unknown>(ui: Page, name: string, params: unknown): Promise<T> {
  const answer = await ui.evaluate(
    async ({ name, params }) => {
      const meta = document.querySelector<HTMLMetaElement>('meta[name="recnrun-token"]');
      const response = await fetch("/api", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${meta?.content}` },
        body: JSON.stringify({ requestId: "e2e", command: name, params }),
      });
      return (await response.json()) as Envelope;
    },
    { name, params },
  );
  if (!answer.ok) throw new Error(`${name} failed: ${answer.error?.message}`);
  return answer.result as T;
}
