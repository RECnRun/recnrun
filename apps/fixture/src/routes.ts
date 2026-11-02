export interface FixtureRoute {
  /** Served at `/routes/<name>` from `public/routes/<name>.html`; also `window.__fixture.route`. */
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  /** `false` for a page whose first script must not read the hook, so it starts with a log instead. */
  readonly headCheck?: false;
}

/** Every page of the fixture; later phases depend on these names. */
export const ROUTES: readonly FixtureRoute[] = [
  { name: "form", title: "Form", summary: "Text, select, checkbox, radio, and file inputs" },
  { name: "debounce", title: "Debounce", summary: "An input handled after 300 ms of silence" },
  { name: "spa", title: "SPA", summary: "Client-side route change with history.pushState" },
  { name: "submit-redirect", title: "Submit and redirect", summary: "A form POST answered 303" },
  { name: "submit-result", title: "Submit result", summary: "Where submit-redirect lands" },
  { name: "iframe", title: "Iframes", summary: "The child page same-origin and cross-site" },
  { name: "iframe-child", title: "Iframe child", summary: "Posts its origin to the parent" },
  { name: "popup", title: "Popup", summary: "Opens a window that reports back" },
  { name: "popup-child", title: "Popup child", summary: "Reports to its opener" },
  {
    name: "popup-child-quiet",
    title: "Quiet popup child",
    summary: "Logs to the console before anything reads the hook",
    headCheck: false,
  },
  {
    name: "virtual-list",
    title: "Virtual list",
    summary: "10 000 rows, only visible ones in the DOM",
  },
  { name: "ime", title: "IME", summary: "Logs composition events" },
  { name: "indexeddb", title: "IndexedDB", summary: "A committed and an aborted transaction" },
  { name: "service-worker", title: "Service worker", summary: "Cache Storage behind a worker" },
  { name: "network", title: "Network", summary: "JSON, binary, 500, redirects, stream, WebSocket" },
  { name: "console", title: "Console", summary: "Log, warn, error, exception, rejection" },
  { name: "download", title: "Download", summary: "An attachment download" },
  { name: "dialogs", title: "Dialogs", summary: "alert and confirm" },
  { name: "storage", title: "Storage", summary: "localStorage, sessionStorage, and cookies" },
  { name: "worker", title: "Worker", summary: "A dedicated worker that answers messages" },
  {
    name: "replay",
    title: "Replay",
    summary: "Every replay action and assertion, a late button, and a slow order form",
  },
];

/**
 * The first script of every page, before any other: it records whether page instrumentation
 * already ran, which proves the hook was installed before the application's first script.
 */
export const HEAD_CHECK = "window.__fixture = { hookSeenAtHead: Boolean(window.__recnrunHook) };";

/** The first script of a page without the head check: a log that leaves the hook unread. */
export const QUIET_LOG = 'console.log("Quiet popup child: first script");';

/** The index page: every route by its `data-testid`, and how to inject a defect. */
export function renderIndex(): string {
  const items = ROUTES.map(
    ({ name, title, summary }) =>
      `        <li><a href="/routes/${name}" data-testid="route-${name}">${title}</a>: ${summary}</li>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <script>
      ${HEAD_CHECK}
    </script>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RECnRun fixture</title>
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/fixture.css" />
    <script type="module" src="/index.js"></script>
  </head>
  <body>
    <header><h1>RECnRun fixture</h1></header>
    <main>
      <p>
        A controllable application for the browser tests. Append <code>?fail=status</code>,
        <code>api-500</code>, <code>slow</code>, or <code>throw</code> to a route to inject a defect.
      </p>
      <ul class="routes">
${items}
      </ul>
    </main>
  </body>
</html>
`;
}
