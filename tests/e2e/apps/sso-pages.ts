// The SSO fixture: an identity provider on sso.localhost and an app at /sso-app/ on app.localhost
// that signs in through it, as an OIDC client keeps its tokens. Page scripts are serialized with
// toString(), so they must not close over imports.
import { literal } from "./app-pages.ts";

export const IDP = "http://sso.localhost:5192";

/** What the app observed on `window.__sso` once it settled on a sign-in state. */
export interface SsoState {
  /** The token the app's first inline script read from its localStorage. */
  first: { token: string | null; time: number };
  signedIn: string | null;
  error: string | null;
  done: boolean;
}

/**
 * The app's first inline script: back from the provider it keeps the user as its token; otherwise
 * it asks the provider silently (`prompt=none`), as an OIDC client checks its session on load.
 */
function ssoApp(run: string, idp: string): void {
  const state: SsoState = {
    first: { token: localStorage.getItem("sso_token"), time: Date.now() },
    signedIn: null,
    error: null,
    done: false,
  };
  (window as unknown as { __sso: SsoState }).__sso = state;
  const query = `run=${encodeURIComponent(run)}`;
  navigator.sendBeacon(`/__log?${query}`, JSON.stringify({ phase: "sso-first", ...state.first }));
  const answer = new URLSearchParams(location.hash.slice(1));
  const back = `${location.origin}${location.pathname}${location.search}`;
  const user = answer.get("user");
  const error = answer.get("error");
  if (user === null && error === null) {
    const silent = `${idp}/sso/authorize?${query}&prompt=none&redirect_uri=${encodeURIComponent(back)}`;
    location.replace(silent);
    return;
  }
  if (user === null) localStorage.removeItem("sso_token");
  else localStorage.setItem("sso_token", user);
  history.replaceState(null, "", back);
  Object.assign(state, { signedIn: user, error, done: true });
  document.addEventListener("DOMContentLoaded", () => {
    document.body.textContent = user === null ? `Not signed in (${error})` : `Signed in as ${user}`;
  });
}

/** `/sso-app/?run=`: only the first inline script; it decides the page. */
export const ssoAppHtml = (run: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SSO app</title>` +
  `<script>(${ssoApp.toString()})(${literal(run)}, ${literal(IDP)});</script>` +
  `</head><body></body></html>`;

/** The provider's sign-in page: it remembers the user in its own storage, then returns. */
function idpSignedIn(user: string, back: string): void {
  localStorage.setItem("idp_user", user);
  location.replace(back);
}

export const idpLoginHtml = (user: string, back: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title>` +
  `<script>(${idpSignedIn.toString()})(${literal(user)}, ${literal(back)});</script>` +
  `</head><body></body></html>`;

/** The provider's page for a spec to read what its origin holds: its localStorage. */
export const idpStorageHtml =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Provider storage</title>` +
  `<script>window.__idp = { localStorage: { ...localStorage } };</script>` +
  `</head><body></body></html>`;

/** The server client's page: the session decided who is signed in; it keeps the user as a token. */
function ssoServer(run: string, user: string | null, error: string | null): void {
  const first = { token: localStorage.getItem("sso_token"), time: Date.now() };
  const state: SsoState = { first, signedIn: user, error, done: true };
  (window as unknown as { __sso: SsoState }).__sso = state;
  navigator.sendBeacon(`/__log?run=${encodeURIComponent(run)}`, JSON.stringify(first));
  if (user !== null) localStorage.setItem("sso_token", user);
}

export const ssoServerHtml = (run: string, user: string | null, error: string | null) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SSO server app</title>` +
  `<script>(${ssoServer.toString()})(${literal(run)}, ${literal(user)}, ${literal(error)});` +
  `</script></head><body>${user === null ? "Not signed in" : "Signed in"}</body></html>`;
