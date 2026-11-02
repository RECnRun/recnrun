import { render } from "preact";
import { createServiceApi, readToken } from "@/api/api";
import { App, Header } from "@/app/App";

function MissingToken() {
  return (
    <>
      <Header />
      <main>
        <p class="error" role="alert">
          This page has no service token. Open the UI with <code>npx @recnrun/cli open</code>.
        </p>
      </main>
    </>
  );
}

/** Renders the UI into the page's root element, if the page has one. */
export function mount(root: HTMLElement | null) {
  if (!root) return;
  const token = readToken(document);
  render(token ? <App api={createServiceApi(token, location)} /> : <MissingToken />, root);
}
