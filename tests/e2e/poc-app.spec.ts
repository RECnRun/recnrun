import { appLog, appState, EMPTY_FIRST_READS, requestsOf } from "./fixtures/app.ts";
import { expect, test } from "./fixtures/extension.ts";
import { openSite } from "./fixtures/session.ts";
import { APP, pageAt, startWorkspace } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

/** Every request the app makes on its first load, after the redirect hop, as `path dest`. */
const APP_REQUESTS = [
  "/app/redirect document",
  "/app/ document",
  "/app/module.js script",
  "/app/frame iframe",
  "/app/pixel.svg image",
  "/app/worker.js worker",
  "/app/data.json empty",
];

for (const csp of [false, true]) {
  const variant = csp ? "under the site's own CSP" : "with no site CSP";

  test(`a plain Incognito start runs every part of the conventional app ${variant}`, async ({
    context,
    serviceWorker,
  }) => {
    const run = `app-${csp ? "csp" : "plain"}-${Date.now()}`;
    const query = `run=${run}${csp ? "&csp=1" : ""}`;
    const site = await openSite(context, "/");
    await startWorkspace(site, serviceWorker, `${APP}/app/redirect?${query}`);
    const app = await pageAt(context, `${APP}/app/?${query}`);

    const state = await appState(app);
    expect(state.failure).toBeUndefined();
    expect(state.first).toMatchObject(EMPTY_FIRST_READS);
    expect(state).toMatchObject({ module: true, worker: "ready", frame: true, image: true });
    expect(state.fetched).toBe("ok");
    // The inline script without a nonce runs only when the site sets no CSP.
    expect(state.unnonced).toBe(!csp);
    const directives = state.violations.map(({ directive }) => directive);
    expect(directives).toEqual(csp ? ["script-src-elem"] : []);

    const entries = await appLog(run);
    expect(requestsOf(entries)).toEqual(expect.arrayContaining(APP_REQUESTS));
    const first = entries.find(
      ({ kind, body }) => kind === "report" && (body as { phase?: string }).phase === "first",
    );
    expect(first?.body).toMatchObject({ phase: "first", ...EMPTY_FIRST_READS });
  });
}
